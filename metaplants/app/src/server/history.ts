import fs from 'fs';
import path from 'path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { SensorSample } from '../shared/types';
import { samplePeak, sampleTrough } from '../shared/soil';

/**
 * Storico delle letture dei sensori.
 *
 * Vive fuori da plants.json per due motivi:
 *  - il polling scriveva l'intero plants.json ad ogni lettura (ogni 60s, per pianta);
 *    su una SD di Raspberry è usura inutile;
 *  - il modello di previsione (predict.ts) ha bisogno di settimane di dati, non dei
 *    10 campioni che stavano in PlantSensors.
 *
 * I campioni sono raggruppati per bucket temporale (l'ultimo valore vince), così la
 * dimensione dello storico non dipende dalla frequenza di polling.
 *
 * Accanto ai campioni vive l'ARCHIVIO della calibrazione: per ogni irrigazione
 * registrata, il secco e il bagnato visti dal sensore attorno a lei. I campioni
 * grezzi durano ~60 giorni, una pianta che si bagna più di rado no — senza
 * l'archivio la sua scala svaniva insieme alle letture, e la % tornava a salire.
 *
 * Su disco sta in SQLite (history.db), non più in history.json. Con ~60 giorni di
 * terreno il JSON era 100-150 KB per pianta riscritti per intero ogni 15 minuti,
 * per aggiungere una manciata di campioni: su una SD è proprio l'usura che questo
 * file esisteva per evitare. Ora ogni salvataggio scrive solo i bucket cambiati.
 *
 * In memoria resta la copia di lavoro, letta ad ogni poll da predict.ts: il
 * database è solo il posto dove sopravvive ai riavvii, e non viene mai interrogato
 * durante il funzionamento normale.
 */

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'));
const DB_FILE = path.join(DATA_DIR, 'history.db');
// Formato delle versioni <= 1.12.1: importato una volta al primo avvio, poi rinominato.
const LEGACY_JSON_FILE = path.join(DATA_DIR, 'history.json');
const LEGACY_JSON_MIGRATED = path.join(DATA_DIR, 'history.json.migrated');

const MINUTE_MS = 60 * 1000;

export type SeriesKey = 'soil' | 'temp' | 'hum';

interface SeriesConfig {
	bucketMs: number;
	maxSamples: number;
}

// Solo il terreno serve al modello: le altre serie tengono giusto abbastanza
// per un eventuale grafico recente.
const SERIES_CONFIG: Record<SeriesKey, SeriesConfig> = {
	soil: { bucketMs: 15 * MINUTE_MS, maxSamples: 5760 }, // ~60 giorni
	temp: { bucketMs: 30 * MINUTE_MS, maxSamples: 96 },   // ~2 giorni
	hum: { bucketMs: 30 * MINUTE_MS, maxSamples: 96 },
};

const SERIES_KEYS = Object.keys(SERIES_CONFIG) as SeriesKey[];

// La forma del campione è condivisa col client, che ne disegna la curva sulla scheda.
export type Sample = SensorSample;

// I due estremi del bucket vivono con le altre regole del terreno (shared/soil.ts):
// li usano storico, previsione e grafico, e devono dire la stessa cosa a tutti.
export { samplePeak, sampleTrough } from '../shared/soil';

type PlantSeries = Record<SeriesKey, Sample[]>;

/**
 * Cosa ha visto il sensore attorno a un'irrigazione registrata, congelato quando
 * l'osservazione è completa: i campioni da cui arriva prima o poi escono dallo
 * storico, questi due numeri no.
 */
export interface ArchivedObservation {
	/** Azione `water` da cui arriva l'osservazione. */
	actionId: string;
	/** Orario dell'azione quando è stata osservata: se la riga viene spostata, non vale più. */
	at: number;
	/**
	 * Minimo prima della risalita, SENZA la regola della pioggia: quella si applica
	 * in lettura, così cambiare la provenienza di una vecchia irrigazione funziona
	 * anche quando le letture attorno a lei non ci sono più.
	 */
	dry: number | null;
	wet: number;
}

const history = new Map<string, PlantSeries>();
const observations = new Map<string, ArchivedObservation[]>();

// Campioni nuovi o modificati dall'ultimo salvataggio. Il bucket aperto cambia ad
// ogni poll, ma su disco ci va una volta per salvataggio, non una per lettura.
const pending = new Map<Sample, { plantId: string; key: SeriesKey }>();
// Serie che hanno perso campioni in coda: su disco vanno potate allo stesso punto.
const trimmed = new Set<string>();

let db: DatabaseSync | null = null;
let statements: {
	upsertSample: StatementSync;
	trimSeries: StatementSync;
	deletePlantSamples: StatementSync;
	deletePlantObservations: StatementSync;
	insertObservation: StatementSync;
} | null = null;
let persistTimer: NodeJS.Timeout | null = null;

const PERSIST_INTERVAL_MS = 15 * MINUTE_MS;

function emptySeries(): PlantSeries {
	return { soil: [], temp: [], hum: [] };
}

function seriesFor(plantId: string): PlantSeries {
	let entry = history.get(plantId);
	if (!entry) {
		entry = emptySeries();
		history.set(plantId, entry);
	}
	return entry;
}

const seriesId = (plantId: string, key: SeriesKey) => `${plantId}\u0000${key}`;
// Inizio del bucket in epoch ms: confrontabile fra serie con bucket di durata diversa.
const bucketOf = (key: SeriesKey, t: number) => {
	const { bucketMs } = SERIES_CONFIG[key];
	return Math.floor(t / bucketMs) * bucketMs;
};

function markPending(plantId: string, key: SeriesKey, sample: Sample): void {
	pending.set(sample, { plantId, key });
}

/** Tiene la serie entro maxSamples; i campioni tolti spariranno anche dal disco. */
function enforceLimit(plantId: string, key: SeriesKey): void {
	const series = seriesFor(plantId)[key];
	const excess = series.length - SERIES_CONFIG[key].maxSamples;
	if (excess <= 0) return;
	for (const dropped of series.splice(0, excess)) pending.delete(dropped);
	trimmed.add(seriesId(plantId, key));
}

function openDatabase(): DatabaseSync {
	if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
	const database = new DatabaseSync(DB_FILE);
	// WAL + synchronous=NORMAL: un salvataggio è un append al log, senza fsync ad
	// ogni transazione. Al peggio un blackout perde l'ultimo salvataggio, che è
	// esattamente quanto perdeva il JSON.
	database.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		CREATE TABLE IF NOT EXISTS samples (
			plant_id TEXT NOT NULL,
			series TEXT NOT NULL,
			bucket INTEGER NOT NULL,
			t INTEGER NOT NULL,
			v REAL NOT NULL,
			peak REAL,
			trough REAL,
			-- Il tempo PRIMA della pianta, di proposito: le righe nuove di tutte le
			-- piante finiscono così nelle ultime pagine del file, e quelle potate nelle
			-- prime. Con (pianta, serie, bucket) ogni salvataggio toccava una pagina per
			-- pianta e serie: 10 piante = ~140 KB scritti per una trentina di campioni.
			PRIMARY KEY (bucket, plant_id, series)
		) WITHOUT ROWID;
		CREATE TABLE IF NOT EXISTS calibration (
			plant_id TEXT NOT NULL,
			action_id TEXT NOT NULL,
			at INTEGER NOT NULL,
			dry REAL,
			wet REAL NOT NULL,
			PRIMARY KEY (plant_id, action_id)
		) WITHOUT ROWID;
	`);
	statements = {
		// La chiave è il bucket e non l'orario: dentro il bucket aperto l'orario
		// avanza ad ogni lettura, e la riga deve restare una sola.
		upsertSample: database.prepare(`
			INSERT INTO samples (plant_id, series, bucket, t, v, peak, trough)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (bucket, plant_id, series)
			DO UPDATE SET t = excluded.t, v = excluded.v, peak = excluded.peak, trough = excluded.trough
		`),
		trimSeries: database.prepare('DELETE FROM samples WHERE plant_id = ? AND series = ? AND bucket < ?'),
		deletePlantSamples: database.prepare('DELETE FROM samples WHERE plant_id = ?'),
		deletePlantObservations: database.prepare('DELETE FROM calibration WHERE plant_id = ?'),
		insertObservation: database.prepare('INSERT INTO calibration (plant_id, action_id, at, dry, wet) VALUES (?, ?, ?, ?, ?)'),
	};
	return database;
}

function inTransaction(work: () => void): void {
	if (!db) return;
	db.exec('BEGIN');
	try {
		work();
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

function writeObservations(plantId: string, list: ArchivedObservation[]): void {
	if (!statements) return;
	statements.deletePlantObservations.run(plantId);
	for (const o of list) statements.insertObservation.run(plantId, o.actionId, o.at, o.dry, o.wet);
}

// Formato di history.json (<= 1.12.1): campioni [secondi, valore, picco?, conca?],
// archivio [idAzione, secondi, secco|null, bagnato].
type LegacySample = [number, number, (number | null)?, (number | null)?];
interface LegacyFile {
	plants?: Record<string, Partial<Record<SeriesKey, LegacySample[]>>>;
	calibration?: Record<string, [string, number, number | null, number][]>;
}

/**
 * Porta history.json nel database, una volta sola. Il file non viene cancellato
 * ma rinominato: se qualcosa va storto, i dati sono ancora lì.
 */
function importLegacyJson(): void {
	if (!fs.existsSync(LEGACY_JSON_FILE)) return;
	const parsed = JSON.parse(fs.readFileSync(LEGACY_JSON_FILE, 'utf-8')) as LegacyFile;
	for (const [plantId, series] of Object.entries(parsed.plants ?? {})) {
		for (const key of SERIES_KEYS) {
			const stored = series[key];
			if (!Array.isArray(stored)) continue;
			const target = seriesFor(plantId)[key];
			for (const entry of stored) {
				if (!Array.isArray(entry) || entry.length < 2) continue;
				const [t, v, peak, trough] = entry;
				const sample: Sample = { t: t * 1000, v };
				if (peak != null) sample.peak = peak;
				if (trough != null) sample.trough = trough;
				target.push(sample);
				markPending(plantId, key, sample);
			}
			enforceLimit(plantId, key);
		}
	}
	for (const [plantId, stored] of Object.entries(parsed.calibration ?? {})) {
		if (!Array.isArray(stored)) continue;
		observations.set(
			plantId,
			stored
				.filter((o) => Array.isArray(o) && typeof o[0] === 'string' && Number.isFinite(o[1]) && Number.isFinite(o[3]))
				.map(([actionId, t, dry, wet]) => ({ actionId, at: t * 1000, dry: dry ?? null, wet })),
		);
	}

	inTransaction(() => {
		flushPendingSamples();
		for (const [plantId, list] of observations) writeObservations(plantId, list);
	});
	fs.renameSync(LEGACY_JSON_FILE, LEGACY_JSON_MIGRATED);
	console.log(`[History] Migrated history.json into SQLite for ${history.size} plant(s)`);
}

function loadFromDatabase(database: DatabaseSync): void {
	const rows = database
		.prepare('SELECT plant_id, series, t, v, peak, trough FROM samples ORDER BY plant_id, series, bucket')
		.all() as { plant_id: string; series: string; t: number; v: number; peak: number | null; trough: number | null }[];
	for (const row of rows) {
		if (!(row.series in SERIES_CONFIG)) continue;
		const sample: Sample = { t: row.t, v: row.v };
		if (row.peak != null) sample.peak = row.peak;
		if (row.trough != null) sample.trough = row.trough;
		seriesFor(row.plant_id)[row.series as SeriesKey].push(sample);
	}
	// Se maxSamples è sceso fra una versione e l'altra, il disco si pota al prossimo salvataggio.
	for (const [plantId] of history) {
		for (const key of SERIES_KEYS) enforceLimit(plantId, key);
	}

	const stored = database
		.prepare('SELECT plant_id, action_id, at, dry, wet FROM calibration ORDER BY plant_id, at')
		.all() as { plant_id: string; action_id: string; at: number; dry: number | null; wet: number }[];
	for (const row of stored) {
		let list = observations.get(row.plant_id);
		if (!list) observations.set(row.plant_id, (list = []));
		list.push({ actionId: row.action_id, at: row.at, dry: row.dry, wet: row.wet });
	}
}

export function loadHistory(): void {
	try {
		db = openDatabase();
		const hasSamples = db.prepare('SELECT 1 FROM samples LIMIT 1').get() != null;
		if (!hasSamples && fs.existsSync(LEGACY_JSON_FILE)) importLegacyJson();
		else loadFromDatabase(db);
		console.log(`[History] Loaded readings for ${history.size} plant(s)`);
	} catch (err) {
		// Senza database lo storico funziona lo stesso, solo che non sopravvive a un riavvio.
		console.error('[History] Failed to load history:', (err as Error).message);
	}
}

function flushPendingSamples(): void {
	if (!statements) return;
	for (const [sample, { plantId, key }] of pending) {
		statements.upsertSample.run(plantId, key, bucketOf(key, sample.t), sample.t, sample.v, sample.peak ?? null, sample.trough ?? null);
	}
	pending.clear();
	for (const id of trimmed) {
		const [plantId, key] = id.split('\u0000') as [string, SeriesKey];
		const first = history.get(plantId)?.[key][0];
		if (first) statements.trimSeries.run(plantId, key, bucketOf(key, first.t));
	}
	trimmed.clear();
}

export function persistHistory(): void {
	if (pending.size === 0 && trimmed.size === 0) return;
	try {
		inTransaction(flushPendingSamples);
	} catch (err) {
		console.error('[History] Failed to persist history:', (err as Error).message);
	}
}

export function startHistoryPersistence(): void {
	if (persistTimer) return;
	persistTimer = setInterval(persistHistory, PERSIST_INTERVAL_MS);
	persistTimer.unref();
}

export function stopHistoryPersistence(): void {
	if (persistTimer) {
		clearInterval(persistTimer);
		persistTimer = null;
	}
	persistHistory();
	try {
		db?.close();
	} catch { /* già chiuso */ }
	db = null;
	statements = null;
}

/**
 * Aggiunge una lettura. Se cade nello stesso bucket dell'ultima, la sostituisce:
 * la frequenza di polling non influenza quindi la dimensione dello storico.
 */
export function recordSample(plantId: string, key: SeriesKey, value: number, at: number = Date.now()): void {
	if (!Number.isFinite(value)) return;
	const { bucketMs } = SERIES_CONFIG[key];
	const series = seriesFor(plantId)[key];
	const rounded = Math.round(value * 100) / 100;
	const last = series[series.length - 1];

	if (last && Math.floor(last.t / bucketMs) === Math.floor(at / bucketMs)) {
		// Stesso bucket: per la curva di asciugatura conta l'ultima lettura, ma i due
		// estremi vanno conservati a parte o gli eventi brevi sparirebbero dentro il
		// quarto d'ora. Il picco serve al 100% della scala; la conca serve allo 0%, ed
		// è quella che l'irrigazione sovrascrive proprio perché arriva subito dopo.
		const highest = Math.max(samplePeak(last), rounded);
		const lowest = Math.min(sampleTrough(last), rounded);
		if (last.v === rounded && last.t === at && samplePeak(last) === highest && sampleTrough(last) === lowest) return;
		last.t = at;
		last.v = rounded;
		if (highest > rounded) last.peak = highest;
		else delete last.peak;
		if (lowest < rounded) last.trough = lowest;
		else delete last.trough;
		markPending(plantId, key, last);
	} else {
		const sample: Sample = { t: at, v: rounded };
		series.push(sample);
		markPending(plantId, key, sample);
		enforceLimit(plantId, key);
	}
}

/** Popola una serie con i vecchi array salvati in PlantSensors (versioni <= 1.9.3). */
export function seedLegacySamples(plantId: string, key: SeriesKey, values: number[]): void {
	const series = seriesFor(plantId)[key];
	if (series.length > 0 || values.length === 0) return;
	// I timestamp originali non erano salvati: li distribuiamo all'indietro a
	// intervalli di un bucket, così l'ordine resta corretto.
	const { bucketMs } = SERIES_CONFIG[key];
	const now = Date.now();
	values.forEach((v, i) => {
		if (!Number.isFinite(v)) return;
		const sample: Sample = { t: now - (values.length - 1 - i) * bucketMs, v: Math.round(v * 100) / 100 };
		series.push(sample);
		markPending(plantId, key, sample);
	});
}

export function getSamples(plantId: string, key: SeriesKey, sinceMs?: number): Sample[] {
	const series = history.get(plantId)?.[key] ?? [];
	if (sinceMs == null) return series.slice();
	return series.filter((s) => s.t >= sinceMs);
}

export function dropPlantHistory(plantId: string): void {
	const series = history.get(plantId);
	if (series) {
		for (const key of SERIES_KEYS) {
			for (const sample of series[key]) pending.delete(sample);
			trimmed.delete(seriesId(plantId, key));
		}
	}
	history.delete(plantId);
	observations.delete(plantId);
	try {
		inTransaction(() => {
			statements?.deletePlantSamples.run(plantId);
			statements?.deletePlantObservations.run(plantId);
		});
	} catch (err) {
		console.error('[History] Failed to drop plant history:', (err as Error).message);
	}
}

export function getArchivedObservations(plantId: string): ArchivedObservation[] {
	return observations.get(plantId)?.slice() ?? [];
}

function sameObservation(a: ArchivedObservation, b: ArchivedObservation): boolean {
	return a.actionId === b.actionId && a.at === b.at && a.dry === b.dry && a.wet === b.wet;
}

/**
 * Sostituisce l'archivio della pianta. Lo decide predict.ts, che sa quali
 * irrigazioni esistono ancora: una riga cancellata o spostata sparisce da qui
 * nello stesso passaggio. Gira ad ogni poll ma cambia solo quando un'irrigazione
 * si chiude o viene toccata, quindi si scrive subito invece di aspettare il
 * salvataggio periodico.
 */
export function setArchivedObservations(plantId: string, list: ArchivedObservation[]): void {
	const current = observations.get(plantId) ?? [];
	if (current.length === list.length && current.every((o, i) => sameObservation(o, list[i]))) return;
	if (list.length === 0) observations.delete(plantId);
	else observations.set(plantId, list.map((o) => ({ ...o })));
	try {
		inTransaction(() => writeObservations(plantId, list));
	} catch (err) {
		console.error('[History] Failed to persist calibration archive:', (err as Error).message);
	}
}
