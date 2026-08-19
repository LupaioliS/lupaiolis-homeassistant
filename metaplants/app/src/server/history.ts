import fs from 'fs';
import path from 'path';
import type { SensorSample } from '../shared/types';
import { samplePeak, sampleTrough } from '../shared/soil';

/**
 * Storico delle letture dei sensori.
 *
 * Vive in un file separato da plants.json per due motivi:
 *  - il polling scriveva l'intero plants.json ad ogni lettura (ogni 60s, per pianta);
 *    su una SD di Raspberry è usura inutile;
 *  - il modello di previsione (predict.ts) ha bisogno di giorni di dati, non dei
 *    10 campioni che stavano in PlantSensors.
 *
 * I campioni sono raggruppati per bucket temporale (l'ultimo valore vince), così la
 * dimensione del file non dipende dalla frequenza di polling.
 */

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'));
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const MINUTE_MS = 60 * 1000;

export type SeriesKey = 'soil' | 'temp' | 'hum';

interface SeriesConfig {
	bucketMs: number;
	maxSamples: number;
}

// Solo il terreno serve al modello: le altre serie tengono giusto abbastanza
// per un eventuale grafico recente.
const SERIES_CONFIG: Record<SeriesKey, SeriesConfig> = {
	soil: { bucketMs: 15 * MINUTE_MS, maxSamples: 1344 }, // ~14 giorni
	temp: { bucketMs: 30 * MINUTE_MS, maxSamples: 96 },   // ~2 giorni
	hum: { bucketMs: 30 * MINUTE_MS, maxSamples: 96 },
};

// La forma del campione è condivisa col client, che ne disegna la curva sulla scheda.
export type Sample = SensorSample;

// I due estremi del bucket vivono con le altre regole del terreno (shared/soil.ts):
// li usano storico, previsione e grafico, e devono dire la stessa cosa a tutti.
export { samplePeak, sampleTrough } from '../shared/soil';

type PlantSeries = Record<SeriesKey, Sample[]>;

// Su disco i campioni sono [secondi, valore], con in coda gli estremi del bucket
// quando ci sono: [.., picco] e [.., picco, conca] — con picco a `null` se c'è solo
// la conca. JSON molto più compatto, e le versioni precedenti leggono comunque le
// prime due (o tre) posizioni ignorando la coda che non conoscono.
type StoredSample =
	| [number, number]
	| [number, number, number | null]
	| [number, number, number | null, number | null];
interface StoredFile {
	version: number;
	plants: Record<string, Partial<Record<SeriesKey, StoredSample[]>>>;
}

const history = new Map<string, PlantSeries>();
let dirty = false;
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

export function loadHistory(): void {
	try {
		if (!fs.existsSync(HISTORY_FILE)) return;
		const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')) as StoredFile;
		for (const [plantId, series] of Object.entries(parsed.plants ?? {})) {
			const target = seriesFor(plantId);
			for (const key of Object.keys(SERIES_CONFIG) as SeriesKey[]) {
				const stored = series[key];
				if (!Array.isArray(stored)) continue;
				target[key] = stored
					.filter((s) => Array.isArray(s) && s.length >= 2)
					.map(([t, v, peak, trough]) => {
						const sample: Sample = { t: t * 1000, v };
						if (peak != null) sample.peak = peak;
						if (trough != null) sample.trough = trough;
						return sample;
					});
			}
		}
		console.log(`[History] Loaded readings for ${history.size} plant(s)`);
	} catch (err) {
		console.error('[History] Failed to load history:', (err as Error).message);
	}
}

export function persistHistory(): void {
	if (!dirty) return;
	try {
		if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
		const out: StoredFile = { version: 1, plants: {} };
		for (const [plantId, series] of history) {
			const entry: Partial<Record<SeriesKey, StoredSample[]>> = {};
			for (const key of Object.keys(SERIES_CONFIG) as SeriesKey[]) {
				if (series[key].length === 0) continue;
				// Si scrive la forma più corta che conserva il dato: la coda compare
				// solo quando dentro il bucket è stato visto qualcosa di diverso da `v`.
				entry[key] = series[key].map((s) => {
					const t = Math.round(s.t / 1000);
					if (s.trough != null) return [t, s.v, s.peak ?? null, s.trough] as StoredSample;
					if (s.peak != null) return [t, s.v, s.peak] as StoredSample;
					return [t, s.v] as StoredSample;
				});
			}
			if (Object.keys(entry).length > 0) out.plants[plantId] = entry;
		}
		fs.writeFileSync(HISTORY_FILE, JSON.stringify(out));
		dirty = false;
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
}

/**
 * Aggiunge una lettura. Se cade nello stesso bucket dell'ultima, la sostituisce:
 * la frequenza di polling non influenza quindi la dimensione dello storico.
 */
export function recordSample(plantId: string, key: SeriesKey, value: number, at: number = Date.now()): void {
	if (!Number.isFinite(value)) return;
	const { bucketMs, maxSamples } = SERIES_CONFIG[key];
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
	} else {
		series.push({ t: at, v: rounded });
		if (series.length > maxSamples) series.splice(0, series.length - maxSamples);
	}
	dirty = true;
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
		series.push({ t: now - (values.length - 1 - i) * bucketMs, v: Math.round(v * 100) / 100 });
	});
	dirty = true;
}

export function getSamples(plantId: string, key: SeriesKey, sinceMs?: number): Sample[] {
	const series = history.get(plantId)?.[key] ?? [];
	if (sinceMs == null) return series.slice();
	return series.filter((s) => s.t >= sinceMs);
}

export function dropPlantHistory(plantId: string): void {
	if (history.delete(plantId)) dirty = true;
}
