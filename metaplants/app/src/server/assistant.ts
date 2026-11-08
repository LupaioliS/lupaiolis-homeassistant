import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
	AssistantAction,
	AssistantActionType,
	AssistantCard,
	AssistantCardKind,
	AssistantState,
	HealthIssueType,
	Plant,
	SeasonalSchedule,
	Season,
} from '../shared/types';
import { getCurrentSeason, getIntervalForSeason } from '../shared/schedule';
import { config } from './config';
import { store } from './store';
import { broadcast } from './events';
import { getReadings } from './sensors';
import { publishPlant } from './mqtt';
import { getSamples, type Sample } from './history';
import { wettingTimes } from './predict';
import { findRises, samplePeak, sampleTrough } from '../shared/soil';

/**
 * L'assistente: un controllo al giorno con Gemini, che risponde con delle card
 * (consigli, domande, azioni proposte).
 *
 * Pensato per spendere poco:
 *  - UNA richiesta al giorno, con soli dati in testo (niente foto) in JSON compatto;
 *  - risposta in JSON con schema fisso, quindi niente giri di conversazione;
 *  - il modello di default è il più economico (flash-lite);
 *  - "chiedi ora" dall'app ha un intervallo minimo, così un dito nervoso non brucia crediti.
 *
 * Le risposte dell'utente alle domande finiscono nel contesto del giorno dopo:
 * è così che l'assistente "impara" senza una conversazione vera.
 *
 * Può applicare da solo solo i cambi piccoli e annullabili (vedi `canAutoApply`):
 * il modello chiede, il server decide. Tutto il resto aspetta una conferma.
 */

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'));
const STATE_FILE = path.join(DATA_DIR, 'assistant.json');

// Sovrascrivibile solo per i test (un finto Gemini in locale).
const API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 60_000;
// "Chiedi ora" non può ripartire prima di così: ogni giro è una richiesta pagata.
const MANUAL_MIN_INTERVAL_MS = 10 * 60 * 1000;
const MAX_CARDS_PER_RUN = 6;
// Le card restano al massimo così a lungo, poi spariscono anche dallo storico.
const CARD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Domande e azioni ancora aperte dopo così vengono chiuse dal giro successivo.
const OPEN_CARD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Card degli ultimi giorni mandate come contesto: così non ripete e usa le risposte.
const CONTEXT_CARDS_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Storico del terreno dato al modello, riassunto (~250 token a pianta invece di
// migliaia di campioni): letture per giorno sugli ultimi 14 giorni, cicli sugli
// ultimi 30 — ne servono almeno tre per poter dire "più veloce del solito".
const SOIL_TREND_MS = 14 * DAY_MS;
const SOIL_CYCLES_MS = 30 * DAY_MS;
const MAX_CYCLES_SENT = 8;
// Soglie dei segnali, in punti grezzi del sensore.
const MIN_RATED_CYCLE_DAYS = 1.5;
const FASTER_RATIO = 1.4;
const SLOWER_RATIO = 0.6;
const MIN_RATE_DIFF = 1;
const NO_RISE_POINTS = 5;
const SHALLOW_POINTS = 15;
const BARELY_DRYING_DAYS = 4;
const BARELY_DRYING_RATE = 1;
const FLAT_POINTS = 0.5;
const FLAT_DAYS = 2;
// Un'acqua registrata entro questo tempo da una risalita è la stessa acqua.
const LOGGED_RISE_MS = 12 * HOUR_MS;
// Livello di partenza di un ciclo: mediana delle letture in questa finestra dopo
// l'acqua, come il livello assestato della calibrazione (il picco dura minuti).
const SETTLE_FROM_MS = 1 * HOUR_MS;
const SETTLE_TO_MS = 4 * HOUR_MS;

const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];
const KINDS: AssistantCardKind[] = ['advice', 'question', 'action'];
const ACTION_TYPES: AssistantActionType[] = [
	'set_watering_schedule',
	'set_fertilizing_schedule',
	'set_soil_threshold',
	'add_health_issue',
	'resolve_health_issue',
	'append_note',
];
const HEALTH_NAMES: Record<HealthIssueType, string[]> = {
	pest: ['aphids', 'spider_mites', 'mealybugs', 'scale', 'whiteflies', 'thrips', 'fungus_gnats', 'slugs'],
	disease: ['powdery_mildew', 'root_rot', 'leaf_spot', 'botrytis', 'rust', 'black_spot', 'downy_mildew'],
	fungus: ['fusarium', 'pythium', 'phytophthora', 'alternaria', 'cercospora', 'anthracnose'],
};
const DEFAULT_WATERING: SeasonalSchedule = { spring: 3, summer: 2, autumn: 5, winter: 7 };
const DEFAULT_FERTILIZING: SeasonalSchedule = { spring: 14, summer: 14, autumn: 30, winter: 60 };

interface PersistedState {
	lastRunAt: string | null;
	lastManualRunAt: string | null;
	lastError: string | null;
	cards: AssistantCard[];
}

let state: PersistedState | null = null;
let running = false;

function load(): PersistedState {
	if (state) return state;
	try {
		if (fs.existsSync(STATE_FILE)) {
			const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Partial<PersistedState>;
			state = {
				lastRunAt: parsed.lastRunAt ?? null,
				lastManualRunAt: parsed.lastManualRunAt ?? null,
				lastError: parsed.lastError ?? null,
				cards: Array.isArray(parsed.cards) ? parsed.cards : [],
			};
			return state;
		}
	} catch (err) {
		console.error('[Assistant] Failed to read state:', (err as Error).message);
	}
	state = { lastRunAt: null, lastManualRunAt: null, lastError: null, cards: [] };
	return state;
}

function save(): void {
	if (!state) return;
	try {
		if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
		const tmp = `${STATE_FILE}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
		fs.renameSync(tmp, STATE_FILE);
	} catch (err) {
		console.error('[Assistant] Failed to save state:', (err as Error).message);
	}
}

export function isAssistantEnabled(): boolean {
	return config.geminiApiKey.length > 0;
}

export function getAssistantState(): AssistantState {
	const s = load();
	return {
		enabled: isAssistantEnabled(),
		model: config.geminiModel,
		lastRunAt: s.lastRunAt,
		lastError: s.lastError,
		running,
		cards: s.cards,
	};
}

function publishState(): void {
	broadcast({ type: 'assistant-updated', state: getAssistantState() });
}

// ── Contesto ────────────────────────────────────────────────────────────────

const day = (iso?: string) => (iso ? iso.slice(0, 10) : null);
const round1 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10);

const round0 = (v: number) => Math.round(v);

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface SoilCycle {
	start: number;
	by: 'watered' | 'unlogged_rise' | 'window_start';
	from: number | null;
	to: number;
	days: number;
	ongoing: boolean;
	rate: number | null;
}

const md = (t: number) => new Date(t).toISOString().slice(5, 10);

/**
 * Il sensore di terreno in forma leggera per il modello: gli ultimi 14 giorni
 * (minimo/massimo/ultima lettura per giorno), i cicli degli ultimi 30 (da
 * un'acqua alla successiva: livello assestato di partenza, arrivo, velocità) e
 * dei segnali già calcolati qui. I segnali sono il punto: un modello economico,
 * dato un elenco di numeri, tende a non accorgersi che una pianta si asciuga il
 * 50% più in fretta di prima (dai dati reali: Rosmarino 6 → 8.5 → 11 punti/giorno
 * in autunno, mai commentato). Il confronto lo fa il codice, gratis e sempre
 * uguale; al modello restano il giudizio (specie, posizione, stagione) e le parole.
 *
 * I cicli si tagliano con `wettingTimes` di predict.ts — la stessa segmentazione
 * della velocità di asciugatura — così le risalite non registrate contano anche qui.
 */
function soilTrend(plant: Plant, now: number, waterTimes: number[], wetPoint: number | null) {
	const soil = getSamples(plant.id, 'soil', now - SOIL_CYCLES_MS);
	if (soil.length < 8) return undefined;
	const dailySince = now - SOIL_TREND_MS;

	const days = new Map<string, { min: number; max: number; last: number }>();
	for (const s of soil) {
		if (s.t < dailySince) continue;
		const key = md(s.t);
		const d = days.get(key);
		if (!d) days.set(key, { min: sampleTrough(s), max: samplePeak(s), last: s.v });
		else {
			d.min = Math.min(d.min, sampleTrough(s));
			d.max = Math.max(d.max, samplePeak(s));
			d.last = s.v;
		}
	}
	const daily = [...days].map(([d, x]) => `${d} ${round0(x.min)} ${round0(x.max)} ${round0(x.last)}`);

	const since = soil[0].t;
	const recentWaters = waterTimes.filter((t) => t >= since - LOGGED_RISE_MS);
	// `wettingTimes` tiene il più tardo tra pulsante e risalita (giusto per la
	// pendenza); qui il ciclo deve cominciare dalla risalita, se c'è, o il ciclo
	// prima finisce con letture già bagnate e l'acqua sembra non essere arrivata
	// (Artemisia: risalita al mattino, acqua registrata alle 22).
	const rises = findRises(soil, plant.sensors?.soilJumpDelta).map((i) => soil[i].t);
	const wettings = wettingTimes(soil, recentWaters, plant.sensors?.soilJumpDelta)
		.map((t) => rises.find((r) => r <= t && t - r <= LOGGED_RISE_MS) ?? t)
		.filter((t) => t >= since);
	const starts = wettings.length > 0 && wettings[0] - since < HOUR_MS ? wettings : [since, ...wettings];
	const cycles: SoilCycle[] = [];
	starts.forEach((start, i) => {
		const end = starts[i + 1] ?? now;
		const inCycle = soil.filter((s) => s.t >= start && s.t < end);
		if (inCycle.length < 2) return;
		const isWetting = wettings.includes(start);
		const last: Sample = inCycle[inCycle.length - 1];
		// Lo spezzone prima della prima acqua della finestra: se è di poche ore non dice nulla.
		if (!isWetting && last.t - inCycle[0].t < DAY_MS) return;
		const settle = inCycle.filter((s) => s.t >= start + SETTLE_FROM_MS && s.t <= start + SETTLE_TO_MS).map((s) => s.v);
		// Acqua appena data: il livello assestato non c'è ancora, la prima lettura sarebbe quella secca.
		const from = !isWetting ? inCycle[0].v : settle.length > 0 ? median(settle) : null;
		const fromAt = isWetting ? start + SETTLE_FROM_MS : inCycle[0].t;
		const spanDays = Math.max(0, (last.t - fromAt) / DAY_MS);
		cycles.push({
			start,
			// watered = acqua registrata, unlogged_rise = il sensore ha visto acqua che nessuno ha registrato
			by: !isWetting ? 'window_start' : recentWaters.some((w) => Math.abs(w - start) <= LOGGED_RISE_MS) ? 'watered' : 'unlogged_rise',
			from,
			to: last.v,
			days: spanDays,
			ongoing: i === starts.length - 1,
			rate: from != null && spanDays >= 0.5 ? (from - last.v) / spanDays : null,
		});
	});

	return {
		daily,
		cycles: cycles.slice(-MAX_CYCLES_SENT).map((c) => ({
			start: new Date(c.start).toISOString().slice(5, 16).replace('T', ' '),
			by: c.by,
			from: c.from == null ? null : round0(c.from),
			to: round0(c.to),
			days: round1(c.days),
			ongoing: c.ongoing || undefined,
			ratePerDay: round1(c.rate),
		})),
		signals: soilSignals(soil, cycles, wetPoint, now),
	};
}

/**
 * I fatti notevoli della curva, in frasi brevi (in inglese: le legge il modello).
 * Sono osservazioni, non diagnosi: una Rhipsalis che perde 3 punti in 10 giorni
 * è normale, un basilico no — quello lo decide il modello, che sa la specie.
 */
function soilSignals(soil: Sample[], cycles: SoilCycle[], wetPoint: number | null, now: number): string[] {
	const signals: string[] = [];
	const season = getCurrentSeason();
	const noRiseDays = new Set<number>();

	// Velocità: l'ultimo ciclo contro i precedenti. Solo cicli partiti da un'acqua
	// (la curva non è una retta: l'inizio di un ciclo scende più in fretta della
	// fine) e abbastanza lunghi da avere una pendenza.
	const rated = cycles.filter((c) => c.by !== 'window_start' && c.rate != null && c.days >= MIN_RATED_CYCLE_DAYS);
	if (rated.length >= 2) {
		const latest = rated[rated.length - 1];
		const usual = median(rated.slice(0, -1).map((c) => c.rate!));
		// Anche in assoluto: 2 punti/giorno contro 1.4 è +43% ma è rumore del sensore.
		if (usual > 0.3 && Math.abs(latest.rate! - usual) >= MIN_RATE_DIFF) {
			const ratio = latest.rate! / usual;
			const pct = Math.round((ratio - 1) * 100);
			const cooling = season === 'autumn' || season === 'winter';
			const versus = `${round1(latest.rate)} points/day in the cycle from ${md(latest.start)} vs ${round1(usual)} in the previous ${rated.length - 1}`;
			if (ratio >= FASTER_RATIO) signals.push(`drying_faster: ${versus} (+${pct}%)${cooling ? `, unusual in ${season}` : ''}`);
			else if (ratio <= SLOWER_RATIO) signals.push(`drying_slower: ${versus} (${pct}%)${cooling ? '' : `, unusual in ${season}`}`);
		}
	}

	// Acqua registrata ma il sensore non si è mosso.
	cycles.forEach((c, i) => {
		const prev = cycles[i - 1];
		if (c.by !== 'watered' || c.from == null || !prev || c.from - prev.to >= NO_RISE_POINTS) return;
		noRiseDays.add(c.start);
		signals.push(`water_without_rise: water logged on ${md(c.start)} but the soil went only from ${round0(prev.to)} to ${round0(c.from)} — the water may not have reached the sensor, or it was logged on the wrong plant/day`);
	});

	// Acqua che non ha bagnato il vaso come al solito.
	if (wetPoint != null) {
		for (const c of cycles) {
			if (c.by === 'window_start' || c.from == null || noRiseDays.has(c.start)) continue;
			if (c.from < wetPoint - SHALLOW_POINTS) {
				signals.push(`shallow_watering: after the water of ${md(c.start)} the soil settled at ${round0(c.from)}, well below its usual wet level ${round0(wetPoint)}`);
			}
		}
	}

	// Ciclo in corso che quasi non scende.
	const current = cycles[cycles.length - 1];
	if (current?.ongoing && current.from != null && current.rate != null && current.days >= BARELY_DRYING_DAYS && current.rate < BARELY_DRYING_RATE) {
		signals.push(`barely_drying: ${round1(current.from - current.to)} points lost in ${round1(current.days)} days since ${md(current.start)}`);
	}

	// Sensore immobile: un sensore capacitivo vero oscilla sempre un po' con la temperatura.
	let flatFrom = soil.length - 1;
	let lo = soil[flatFrom].v;
	let hi = lo;
	while (flatFrom > 0) {
		const v = soil[flatFrom - 1].v;
		if (Math.max(hi, v) - Math.min(lo, v) > FLAT_POINTS) break;
		lo = Math.min(lo, v);
		hi = Math.max(hi, v);
		flatFrom--;
	}
	const flatDays = (now - soil[flatFrom].t) / DAY_MS;
	if (flatDays >= FLAT_DAYS) signals.push(`sensor_flat: the reading has stayed at ${round1(lo)} for ${round1(flatDays)} days — possibly a stuck or disconnected sensor`);

	const unlogged = cycles.filter((c) => c.by === 'unlogged_rise');
	if (unlogged.length >= 2) {
		signals.push(`unlogged_waterings: the sensor saw ${unlogged.length} waterings nobody logged (${unlogged.map((c) => md(c.start)).join(', ')}) — rain, someone else, or forgotten logs`);
	}
	return signals;
}

/** Un riassunto compatto della pianta: solo ciò che serve a dare un consiglio. */
function describePlant(plant: Plant, now: number) {
	const season = getCurrentSeason();
	const actions = store.getActions(plant.id).sort((a, b) => a.date.localeCompare(b.date));
	const waters = actions.filter((a) => a.type === 'water').slice(-6);
	const checks = actions.filter((a) => a.type === 'check').slice(-3);
	const ferts = actions.filter((a) => a.type === 'fertilize').slice(-3);
	const readings = getReadings(plant.id);
	const prediction = readings?.prediction;
	const calibration = prediction?.calibration;
	const watering = plant.wateringSchedule ?? DEFAULT_WATERING;
	const fertilizing = plant.fertilizingSchedule ?? DEFAULT_FERTILIZING;

	return {
		id: plant.id,
		name: plant.nickname ? `${plant.name} (${plant.nickname})` : plant.name,
		species: plant.species || undefined,
		location: plant.location || undefined,
		potCm: plant.potSizeCm,
		notes: plant.notes ? plant.notes.slice(0, 300) : undefined,
		watering: {
			scheduleDays: watering,
			currentDays: getIntervalForSeason(plant.wateringSchedule, season, plant.wateringIntervalDays ?? 3),
			daysSinceLast: plant.lastWatered ? round1((now - new Date(plant.lastWatered).getTime()) / DAY_MS) : null,
			recent: waters.map((a) => [day(a.date), a.source ?? 'manual', a.amount ?? null].filter((v) => v != null).join(' ')),
		},
		fertilizing: {
			scheduleDays: fertilizing,
			recent: ferts.map((a) => day(a.date)),
		},
		lastRepotted: day(plant.lastRepotted),
		lastPruned: day(plant.lastPruned),
		fingerTests: checks.length ? checks.map((a) => `${day(a.date)} ${a.soil}`) : undefined,
		soilSensor: plant.sensors?.soilHumidity
			? {
				raw: readings?.soilHumidity ?? null,
				// 0 = livello a cui di solito si innaffia, 100 = terreno assestato dopo l'acqua.
				plantScalePercent: prediction?.normalizedSoilHumidity ?? null,
				learnedFromWaterings: calibration?.samples ?? 0,
				dryPointRaw: calibration?.dryPoint ?? null,
				wetPointRaw: calibration?.wetPoint ?? null,
				dryRatePerDay: prediction?.dryRatePerDay ?? null,
				estimatedDaysLeft: prediction?.daysLeft ?? null,
				estimateConfidence: prediction?.confidence ?? null,
				manualThreshold: plant.sensors.soilHumidityThreshold ?? null,
				history: soilTrend(plant, now, actions.filter((a) => a.type === 'water').map((a) => new Date(a.date).getTime()), calibration?.wetPoint ?? null),
			}
			: undefined,
		climate: readings && (readings.temperature != null || readings.ambientHumidity != null)
			? { temperatureC: readings.temperature, airHumidity: readings.ambientHumidity }
			: undefined,
		openHealthIssues: (plant.healthIssues ?? [])
			.filter((i) => !i.resolvedDate)
			.map((i) => ({ id: i.id, type: i.type, name: i.name, since: day(i.detectedDate), notes: i.notes })),
	};
}

function buildContext(now: number) {
	const s = load();
	const recentCards = s.cards
		.filter((c) => now - new Date(c.createdAt).getTime() < CONTEXT_CARDS_MS)
		.map((c) => ({
			date: day(c.createdAt),
			plantId: c.plantId,
			kind: c.kind,
			title: c.title,
			status: c.status,
			answer: c.answer,
			action: c.action?.type,
		}));
	return {
		today: new Date(now).toISOString().slice(0, 10),
		season: getCurrentSeason(),
		plants: store.getPlants().map((p) => describePlant(p, now)),
		previousCards: recentCards,
	};
}

function systemInstruction(): string {
	const language = config.lang === 'en' ? 'English' : 'Italian';
	return `You are the daily plant-care assistant of MetaPlants, a home plant tracker. Once a day you get a JSON snapshot of the user's plants and reply with a review of every plant plus a few short cards. The user reads the cards on the phone, standing in front of the plants: each card must be understandable in five seconds and say what to look at or do.

# The input
- today, season (spring/summer/autumn/winter, northern hemisphere).
- plants[]: one entry per plant.
  - name, species, location (indoor room or outdoor spot like "Terrazza": outdoor plants get rain, sun and wind), potCm, notes (written by the user: trust them).
  - watering.scheduleDays: watering interval in days per season; currentDays = today's. daysSinceLast: days since the last logged watering. recent: last waterings as "date source amount" (source manual/rain/irrigation; amount little/normal/lots, absent = not recorded). The user never measures ml: never talk about ml.
  - fertilizing.scheduleDays / recent: same for fertilizing.
  - lastRepotted, lastPruned: dates or null (null = never recorded, not "never done").
  - fingerTests: only plants without a soil sensor. "moist"/"wet" = the user touched the soil and it did not need water yet ("dry" is logged as a watering instead).
  - soilSensor (only some plants):
    - plantScalePercent: the reading on this plant's own learned scale. 0 = the level at which this plant is usually watered, 100 = soil settled after a full watering. This is the number the user sees in the app: when you tell the user how wet a plant is, use this one, never the raw value.
    - raw: the raw sensor reading (0-100). dryPointRaw / wetPointRaw: raw readings that correspond to 0 and 100 on the plant's scale. learnedFromWaterings: how many waterings the scale was learned from (0 = no scale yet, manualThreshold on the raw reading is used instead).
    - dryRatePerDay (raw points lost per day), estimatedDaysLeft (days until 0 on the scale), estimateConfidence (low/medium/high).
    - history.daily: last 14 days, one string per day "MM-DD min max last" in raw points (UTC days).
    - history.cycles: last 30 days, one per wetting: start "MM-DD hh:mm" (UTC), by = "watered" (logged by the user) | "unlogged_rise" (the sensor saw water nobody logged) | "window_start" (the cycle began before the window), from = settled raw level a few hours after the water (null = just watered), to = latest raw level of the cycle, days, ratePerDay (raw points lost per day), ongoing = the current cycle.
    - history.signals: notable facts ALREADY COMPUTED from the history by the app. They are reliable measurements; your job is to judge what they mean for this plant. See "Soil signals" below.
  - climate: current temperature (°C) and air humidity near the plant, when a sensor exists.
  - openHealthIssues: pests/diseases the user logged and not yet resolved (id, type, name, since, notes).
- previousCards: your cards of the last 14 days, with status (open/answered/applied/dismissed/expired...) and the user's answer. They are your memory: use the answers as facts, don't repeat a card the user answered or dismissed, don't ask the same question again, and don't re-propose an action that was dismissed.

# Step 1 — review (the "review" array, mandatory)
One entry for EVERY plant in the input, in input order, before writing any card:
- status "ok": nothing worth the user's attention today. Most plants on most days are ok.
- status "watch": something mildly unusual, explainable, or not yet clear (one cycle out of line, little data). Usually no card; mention it again tomorrow only if it persists or grows.
- status "problem": something the user should look at or act on: a soil signal that this plant's species, place and season don't explain; a sensor that looks broken; a health issue open for weeks with no news; a schedule clearly at odds with how the plant really behaves.
- why: one line in English with the data behind the status (e.g. "drying_faster +52% in autumn, outdoor terrace, no rain logged"). For "ok" a few words are enough.

# Step 2 — cards (the "cards" array, 0 to ${MAX_CARDS_PER_RUN})
Write cards only for "problem" plants, for "watch" plants when the card brings new information, and for topics about all plants (a season change). Zero cards is a fine answer on a quiet day: never pad, never write generic tips ("remember to water in summer").
Priority when there's more to say than ${MAX_CARDS_PER_RUN} cards: 1) soil signals and broken sensors, 2) health issues, 3) schedule changes, 4) season and fertilizing remarks. At most 2 health follow-up cards per run.

## Soil signals: what they mean and what to write
Judge every signal against species (succulents, cacti, Rhipsalis, Sansevieria, Zamioculcas... dry slowly by nature; herbs like basil and rosemary, ferns and plants in small pots dry fast), location (outdoor = sun, wind, rain), pot size, season and climate.
- drying_faster: the latest cycle loses water much faster than the previous ones. Possible causes, from most to least common: more sun or heat (moved, heater, heatwave), wind outdoors, a plant that grew and drinks more, roots filling the pot (look at lastRepotted), a smaller pot. "unusual in autumn/winter" makes it stronger: plants should slow down when it gets cold. Write a "question" asking what changed, with options that map to the causes (e.g. "Moved to the sun", "Heater nearby", "It has grown a lot", "Nothing changed").
- drying_slower / barely_drying: the plant is drinking less. Normal in autumn/winter and for slow species, and right after repotting. Otherwise: less light (moved?), cold, a plant that stopped growing, or roots not working (root rot after too much water): if plantScalePercent stays high for days, say that waiting before watering again is right and suggest checking drainage and leaves. Ask with a "question" when the cause matters.
- water_without_rise: a logged watering with no rise in the soil. Either the water didn't reach the sensor (little water, very dry soil that repels water and runs down the sides, sensor near the edge) or the log is on the wrong plant/day. Ask which, with options like "Little water", "Logged by mistake", "Watered another plant".
- shallow_watering: the water settled well below this plant's usual wet level: advise watering slowly until it drains from the bottom, or soaking the pot if the soil is very dry. Use the amount from watering.recent if recorded.
- sensor_flat: the reading has not moved for days. Before trusting the plant's scale, the user should check the sensor (battery, connection, sensor pulled out of the soil). This is a "problem", and a short advice card is enough.
- unlogged_waterings: outdoors with rain this is normal: say nothing unless asked. Indoors, ask who waters it, with options (e.g. "Someone else at home", "I forget to log it", "I don't know").
- No signals = the curve looks normal: don't comment on it.

## Other things to look at
- Plants without a soil sensor: two or more recent "moist"/"wet" finger tests mean the interval is too short for the current season: propose a longer one (set_watering_schedule) sized to what the tests show.
- A sensor plant's scheduleDays is only a fallback for when the sensor stops working. Propose aligning it only when the real cycle length (history.cycles days) differs from currentDays by more than half, and at low priority.
- Never tell the user to water a sensor plant whose plantScalePercent is above 0, whatever the calendar says. Never tell them to water at all: the app already does that. You explain why and suggest what to check or change.
- Fertilizing in autumn/winter only if the species really needs it; repotting only with a concrete reason (fast drying, years since lastRepotted for a fast grower).

# Card format
- kind "advice": an observation with what to do. It must not ask anything: the user can't reply to it.
- kind "question": whenever you ask anything. 2-4 options, short (max 25 characters), mutually exclusive, covering the likely answers. The answer comes back in previousCards tomorrow.
- kind "action": a concrete change to the app's data. Whenever you suggest something this catalog can do ("let's move it to 21 days"), it MUST be an action card with the action filled in — never only in the text of an advice card, or the user has no button to apply it. Catalog (season is required for schedules: use today's season for a change meant for now):
  - set_watering_schedule {season, value: days 1-90}
  - set_fertilizing_schedule {season, value: days 1-180}
  - set_soil_threshold {value: raw % 1-90} — only for plants with a soil sensor and learnedFromWaterings = 0
  - add_health_issue {issueType: pest|disease|fungus, issueName: one of ${JSON.stringify(HEALTH_NAMES)}, text: notes}
  - resolve_health_issue {issueId, text: treatment} — the preferred way to follow up a health issue open for weeks (the user confirms it's gone)
  - append_note {text: max 300 chars}
  autoApply true only for small, low-risk changes you are confident about (a schedule moved by a day or two, a note); the app may still ask to confirm. Anything about health: autoApply false.
- plantId: the plant's id for a card about one plant, "all" only for a card about every plant. action: {type: "none"} when the card proposes no change.
- title: max 40 characters, starting with the plant's name (without the nickname). body: max 280 characters, with the numbers that support it (dates, percentages on the plant's scale, "11 points a day instead of 7"), plain words, no jargon like "raw", "cycle", "signal" or "calibration".
- Write title, body and options in ${language}, friendly and concrete.
- Never invent events (waterings, rain, pests, moves) that are not in the data or in the user's answers, and never propose logging a watering or fertilizing: only the user knows what they did.

Example of a good card, in Italian (for a drying_faster signal on an outdoor rosemary in autumn):
{"kind":"question","title":"Rosmarino beve più in fretta","body":"Rosmarino ora perde 11 punti al giorno, prima 7: in autunno di solito rallenta. È cambiato qualcosa?","options":["Spostato al sole","È cresciuto molto","Tanto vento","Niente"],"action":{"type":"none"}}`;
}

// Le scelte chiuse si danno al modello come enum, non come istruzioni: dai dati
// reali gemini-3.8-flash ha scritto nel campo della pianta "<id> companion: Belin
// ... placeholder text" e ha omesso l'azione, e la card è arrivata senza pulsante.
// Con l'enum può scegliere solo un id vero; con `action` obbligatorio (con "none"
// come scelta esplicita) non può più dimenticarla.
const NO_PLANT = 'all';
const NO_ACTION = 'none';

function responseSchema(plantIds: string[], issueIds: string[]) {
	return {
		type: 'OBJECT',
		properties: {
			// Prima fase, nella stessa richiesta: un giudizio su OGNI pianta prima
			// delle card. Costa ~15 token a pianta e obbliga il modello a guardarle
			// tutte, invece di fermarsi alle prime cose evidenti (in prova scriveva
			// tre card sui parassiti e ignorava la curva del terreno).
			review: {
				type: 'ARRAY',
				items: {
					type: 'OBJECT',
					properties: {
						plantId: { type: 'STRING', enum: plantIds },
						status: { type: 'STRING', enum: REVIEW_STATUSES },
						why: { type: 'STRING' },
					},
					required: ['plantId', 'status', 'why'],
					propertyOrdering: ['plantId', 'status', 'why'],
				},
			},
			cards: {
				type: 'ARRAY',
				items: {
					type: 'OBJECT',
					properties: {
						plantId: { type: 'STRING', enum: [...plantIds, NO_PLANT] },
						kind: { type: 'STRING', enum: KINDS },
						title: { type: 'STRING' },
						body: { type: 'STRING' },
						options: { type: 'ARRAY', items: { type: 'STRING' }, nullable: true },
						autoApply: { type: 'BOOLEAN', nullable: true },
						action: {
							type: 'OBJECT',
							properties: {
								type: { type: 'STRING', enum: [...ACTION_TYPES, NO_ACTION] },
								season: { type: 'STRING', enum: SEASONS, nullable: true },
								value: { type: 'NUMBER', nullable: true },
								issueType: { type: 'STRING', enum: ['pest', 'disease', 'fungus'], nullable: true },
								issueName: { type: 'STRING', nullable: true },
								...(issueIds.length > 0 ? { issueId: { type: 'STRING', enum: issueIds, nullable: true } } : {}),
								text: { type: 'STRING', nullable: true },
							},
							required: ['type'],
						},
					},
					required: ['plantId', 'kind', 'title', 'body', 'action'],
					propertyOrdering: ['plantId', 'kind', 'title', 'body', 'options', 'action', 'autoApply'],
				},
			},
		},
		required: ['review', 'cards'],
		propertyOrdering: ['review', 'cards'],
	};
}

const REVIEW_STATUSES = ['ok', 'watch', 'problem'];

interface RawReview {
	plantId?: string;
	status?: string;
	why?: string;
}

interface RawCard {
	plantId?: string | null;
	kind?: string;
	title?: string;
	body?: string;
	options?: string[] | null;
	autoApply?: boolean | null;
	action?: (Partial<AssistantAction> & { type?: string }) | null;
}

/**
 * Il ragionamento al minimo, per famiglia di modello. I modelli che "pensano"
 * spendono il pensiero dentro maxOutputTokens: con gemini-3.8-flash 1965 token su
 * 2048 se ne andavano a ragionare e il JSON arrivava troncato a metà. Per dei
 * consigli su dati già digeriti il ragionamento non serve, e si paga come output.
 */
function thinkingConfig(model: string): Record<string, unknown> | undefined {
	if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
	// Dalla serie 3 si regola a livelli; "minimal" non c'è su tutti, "low" sì.
	if (/^gemini-[3-9]/.test(model)) return { thinkingLevel: 'low' };
	return undefined;
}

interface GeminiResponse {
	candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
	usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

function schemaForCurrentPlants() {
	const plants = store.getPlants();
	const issueIds = plants.flatMap((p) => (p.healthIssues ?? []).filter((i) => !i.resolvedDate).map((i) => i.id));
	return responseSchema(plants.map((p) => p.id), issueIds);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** La pianta della card, anche se l'id arriva sporco (testo attorno all'uuid). */
function resolvePlant(raw: string | null | undefined): Plant | undefined {
	if (!raw || raw === NO_PLANT) return undefined;
	return store.getPlant(raw) ?? store.getPlant(raw.match(UUID_RE)?.[0] ?? '');
}

async function requestGemini(context: unknown, thinking: Record<string, unknown> | undefined): Promise<Response> {
	return fetch(`${API_BASE}/${encodeURIComponent(config.geminiModel)}:generateContent`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
		body: JSON.stringify({
			systemInstruction: { parts: [{ text: systemInstruction() }] },
			contents: [{ role: 'user', parts: [{ text: JSON.stringify(context) }] }],
			generationConfig: {
				responseMimeType: 'application/json',
				responseSchema: schemaForCurrentPlants(),
				temperature: 0.3,
				// È un tetto, non un costo: si pagano i token usati (~500 per un giro).
				// Largo perché un modello che ragiona comunque non resti senza spazio.
				maxOutputTokens: 8192,
				...(thinking ? { thinkingConfig: thinking } : {}),
			},
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

async function callGemini(context: unknown): Promise<RawCard[]> {
	const thinking = thinkingConfig(config.geminiModel);
	let res = await requestGemini(context, thinking);
	// Un modello che non accetta quell'impostazione rifiuta la richiesta senza
	// generare niente (quindi senza costo): si riprova una volta senza.
	if (res.status === 400 && thinking) {
		const detail = await res.text().catch(() => '');
		if (!/think/i.test(detail)) throw new Error(`Gemini HTTP 400: ${detail.slice(0, 300)}`);
		console.warn(`[Assistant] ${config.geminiModel} rejected thinkingConfig, retrying without it`);
		res = await requestGemini(context, undefined);
	}
	if (!res.ok) {
		const detail = (await res.text().catch(() => '')).slice(0, 300);
		throw new Error(`Gemini HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
	}
	const data = (await res.json()) as GeminiResponse;
	const usage = data.usageMetadata;
	if (usage) {
		console.log(`[Assistant] Tokens: ${usage.promptTokenCount ?? '?'} in, ${usage.candidatesTokenCount ?? '?'} out, ${usage.thoughtsTokenCount ?? 0} thinking`);
	}
	const finish = data.candidates?.[0]?.finishReason;
	const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
	if (finish === 'MAX_TOKENS') throw new Error('Gemini response cut off (MAX_TOKENS): try a model that thinks less');
	if (!text) throw new Error(`Gemini returned no content (${finish ?? 'unknown'})`);
	try {
		const parsed = JSON.parse(text) as { review?: RawReview[]; cards?: RawCard[] };
		// La revisione serve al modello per ragionare; qui finisce solo nel log,
		// per capire dopo perché ha scritto (o non scritto) una card.
		for (const r of Array.isArray(parsed.review) ? parsed.review : []) {
			if (r.status && r.status !== 'ok') console.log(`[Assistant] review ${store.getPlant(r.plantId ?? '')?.name ?? r.plantId}: ${r.status} — ${r.why ?? ''}`);
		}
		return Array.isArray(parsed.cards) ? parsed.cards : [];
	} catch (err) {
		throw new Error(`Gemini returned invalid JSON (${finish ?? 'unknown'}): ${(err as Error).message}`);
	}
}

// ── Validazione e azioni ────────────────────────────────────────────────────

function cleanText(value: unknown, max: number): string {
	return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** L'azione così com'è arrivata, se è nel catalogo e ha senso per quella pianta; altrimenti null. */
function validateAction(raw: RawCard['action'], plant: Plant | undefined): AssistantAction | null {
	if (!raw || !plant || !ACTION_TYPES.includes(raw.type as AssistantActionType)) return null;
	const type = raw.type as AssistantActionType;
	const value = typeof raw.value === 'number' && Number.isFinite(raw.value) ? Math.round(raw.value) : null;
	// "Portiamolo a 21 giorni" senza stagione vuol dire adesso: era il caso più
	// comune di azione scartata, con la card rimasta senza pulsante.
	const season = SEASONS.includes(raw.season as Season) ? (raw.season as Season) : getCurrentSeason();

	switch (type) {
		case 'set_watering_schedule':
			return season && value != null && value >= 1 && value <= 90 ? { type, season, value } : null;
		case 'set_fertilizing_schedule':
			return season && value != null && value >= 1 && value <= 180 ? { type, season, value } : null;
		case 'set_soil_threshold':
			return plant.sensors?.soilHumidity && value != null && value >= 1 && value <= 90 ? { type, value } : null;
		case 'add_health_issue': {
			const issueType = raw.issueType as HealthIssueType;
			if (!HEALTH_NAMES[issueType]?.includes(raw.issueName ?? '')) return null;
			return { type, issueType, issueName: raw.issueName, text: cleanText(raw.text, 300) || undefined };
		}
		case 'resolve_health_issue':
			return plant.healthIssues?.some((i) => i.id === raw.issueId && !i.resolvedDate)
				? { type, issueId: raw.issueId, text: cleanText(raw.text, 300) || undefined }
				: null;
		case 'append_note': {
			const text = cleanText(raw.text, 300);
			return text ? { type, text } : null;
		}
	}
}

function currentScheduleValue(plant: Plant, action: AssistantAction): number {
	const schedule = action.type === 'set_watering_schedule'
		? plant.wateringSchedule ?? DEFAULT_WATERING
		: plant.fertilizingSchedule ?? DEFAULT_FERTILIZING;
	return schedule[action.season!];
}

/**
 * L'ultima parola sull'applicare da soli è del server, non del modello: solo note
 * e ritocchi di frequenza entro ±30% (almeno un giorno). Salute, soglie e cambi
 * grandi chiedono sempre conferma.
 */
function canAutoApply(plant: Plant, action: AssistantAction): boolean {
	if (action.type === 'append_note') return true;
	if (action.type === 'set_watering_schedule' || action.type === 'set_fertilizing_schedule') {
		const current = currentScheduleValue(plant, action);
		return Math.abs(action.value! - current) <= Math.max(1, Math.round(current * 0.3));
	}
	return false;
}

function afterPlantChange(plant: Plant): void {
	publishPlant(plant);
	broadcast({ type: 'plant-updated', plant });
}

/** Applica l'azione e restituisce ciò che serve per annullarla. */
function applyAction(plantId: string, action: AssistantAction): unknown {
	const plant = store.getPlant(plantId);
	if (!plant) throw new Error('Plant not found');
	const season = getCurrentSeason();
	let updated: Plant | undefined;
	let previous: unknown;

	switch (action.type) {
		case 'set_watering_schedule': {
			const schedule = { ...(plant.wateringSchedule ?? DEFAULT_WATERING) };
			previous = plant.wateringSchedule ?? null;
			schedule[action.season!] = action.value!;
			updated = store.updatePlant(plantId, {
				wateringSchedule: schedule,
				wateringIntervalDays: getIntervalForSeason(schedule, season, 3),
			});
			break;
		}
		case 'set_fertilizing_schedule': {
			const schedule = { ...(plant.fertilizingSchedule ?? DEFAULT_FERTILIZING) };
			previous = plant.fertilizingSchedule ?? null;
			schedule[action.season!] = action.value!;
			updated = store.updatePlant(plantId, {
				fertilizingSchedule: schedule,
				fertilizingIntervalDays: getIntervalForSeason(schedule, season, 14),
			});
			break;
		}
		case 'set_soil_threshold':
			previous = plant.sensors?.soilHumidityThreshold ?? null;
			updated = store.updatePlant(plantId, { sensors: { ...plant.sensors, soilHumidityThreshold: action.value } });
			break;
		case 'add_health_issue': {
			const issue = store.addHealthIssue(plantId, {
				type: action.issueType!,
				name: action.issueName as never,
				detectedDate: new Date().toISOString(),
				notes: action.text,
			});
			previous = issue?.id ?? null;
			updated = store.getPlant(plantId);
			break;
		}
		case 'resolve_health_issue':
			store.resolveHealthIssue(plantId, action.issueId!, action.text);
			previous = action.issueId;
			updated = store.getPlant(plantId);
			break;
		case 'append_note':
			previous = plant.notes ?? null;
			updated = store.updatePlant(plantId, {
				notes: plant.notes ? `${plant.notes}\n${action.text}` : action.text,
			});
			break;
	}
	if (updated) afterPlantChange(updated);
	return previous;
}

function undoAction(plantId: string, action: AssistantAction, previous: unknown): void {
	const plant = store.getPlant(plantId);
	if (!plant) throw new Error('Plant not found');
	const season = getCurrentSeason();
	let updated: Plant | undefined;

	switch (action.type) {
		case 'set_watering_schedule': {
			const schedule = (previous as SeasonalSchedule | null) ?? undefined;
			updated = store.updatePlant(plantId, {
				wateringSchedule: schedule,
				wateringIntervalDays: getIntervalForSeason(schedule, season, 3),
			});
			break;
		}
		case 'set_fertilizing_schedule': {
			const schedule = (previous as SeasonalSchedule | null) ?? undefined;
			updated = store.updatePlant(plantId, {
				fertilizingSchedule: schedule,
				fertilizingIntervalDays: getIntervalForSeason(schedule, season, 14),
			});
			break;
		}
		case 'set_soil_threshold':
			updated = store.updatePlant(plantId, {
				sensors: { ...plant.sensors, soilHumidityThreshold: (previous as number | null) ?? undefined },
			});
			break;
		case 'add_health_issue':
			updated = store.updatePlant(plantId, {
				healthIssues: (plant.healthIssues ?? []).filter((i) => i.id !== previous),
			});
			break;
		case 'resolve_health_issue':
			updated = store.updatePlant(plantId, {
				healthIssues: (plant.healthIssues ?? []).map((i) =>
					i.id === previous ? { ...i, resolvedDate: undefined, treatment: undefined } : i,
				),
			});
			break;
		case 'append_note':
			updated = store.updatePlant(plantId, { notes: (previous as string | null) ?? undefined });
			break;
	}
	if (updated) afterPlantChange(updated);
}

function toCard(raw: RawCard, now: string): AssistantCard | null {
	const title = cleanText(raw.title, 120);
	const body = cleanText(raw.body, 600);
	if (!title || !body) return null;
	const plant = resolvePlant(raw.plantId);
	let kind: AssistantCardKind = KINDS.includes(raw.kind as AssistantCardKind) ? (raw.kind as AssistantCardKind) : 'advice';

	const card: AssistantCard = {
		id: randomUUID(),
		createdAt: now,
		updatedAt: now,
		plantId: plant?.id,
		kind,
		title,
		body,
		status: 'open',
	};

	if (kind === 'question') {
		const options = (raw.options ?? []).map((o) => cleanText(o, 60)).filter(Boolean).slice(0, 4);
		if (options.length >= 2) card.options = options;
		else kind = card.kind = 'advice';
	}

	// Una proposta compilata vale come azione anche se il modello l'ha etichettata
	// come consiglio: il pulsante serve proprio lì.
	if (kind === 'advice' && ACTION_TYPES.includes(raw.action?.type as AssistantActionType)) kind = card.kind = 'action';

	if (kind === 'action') {
		const action = validateAction(raw.action, plant);
		if (!action) {
			// Fuori catalogo o non sensata per questa pianta: resta il consiglio, senza pulsante.
			console.warn(`[Assistant] Action rejected (plant ${raw.plantId ?? 'none'}${plant ? '' : ' not found'}): ${JSON.stringify(raw.action)}`);
			card.kind = 'advice';
		} else {
			card.action = action;
			if (raw.autoApply && plant && canAutoApply(plant, action)) {
				try {
					card.previous = applyAction(plant.id, action);
					card.autoApplied = true;
					card.status = 'applied';
				} catch (err) {
					console.error('[Assistant] Auto-apply failed:', (err as Error).message);
				}
			}
		}
	}
	return card;
}

// ── Giri ────────────────────────────────────────────────────────────────────

/** Le card vecchie escono; quelle ancora aperte di giri precedenti si chiudono da sole. */
function ageCards(now: number): void {
	const s = load();
	const nowIso = new Date(now).toISOString();
	s.cards = s.cards.filter((c) => now - new Date(c.createdAt).getTime() < CARD_RETENTION_MS);
	for (const card of s.cards) {
		if (card.status !== 'open') continue;
		const age = now - new Date(card.createdAt).getTime();
		// Un consiglio vale per il giorno in cui è dato; domande e azioni aspettano un po'.
		if (card.kind === 'advice' || age > OPEN_CARD_MAX_AGE_MS) {
			card.status = 'dismissed';
			card.updatedAt = nowIso;
		}
	}
}

export async function runAssistant(trigger: 'daily' | 'manual'): Promise<AssistantState> {
	if (!isAssistantEnabled()) throw new Error('Assistant disabled: no Gemini API key configured');
	if (running) return getAssistantState();
	const s = load();
	const now = Date.now();
	if (trigger === 'manual' && s.lastManualRunAt && now - new Date(s.lastManualRunAt).getTime() < MANUAL_MIN_INTERVAL_MS) {
		throw new Error('TOO_SOON');
	}

	running = true;
	publishState();
	try {
		const context = buildContext(now);
		const raw = await callGemini(context);
		const nowIso = new Date().toISOString();
		ageCards(now);
		const cards = raw.slice(0, MAX_CARDS_PER_RUN).map((c) => toCard(c, nowIso)).filter((c): c is AssistantCard => c != null);
		s.cards = [...cards, ...s.cards];
		s.lastRunAt = nowIso;
		s.lastError = null;
		console.log(`[Assistant] ${trigger} run: ${cards.length} card(s)`);
	} catch (err) {
		s.lastError = (err as Error).message;
		// Anche un giro fallito conta come fatto: niente nuovi tentativi (e costi) fino a domani.
		s.lastRunAt = new Date().toISOString();
		console.error('[Assistant] Run failed:', s.lastError);
	} finally {
		if (trigger === 'manual') s.lastManualRunAt = new Date(now).toISOString();
		running = false;
		save();
		publishState();
	}
	return getAssistantState();
}

/** Chiamata ogni minuto dallo scheduler: un giro al giorno, dall'ora configurata in poi. */
export function maybeRunDaily(now = new Date()): void {
	if (!isAssistantEnabled() || running) return;
	if (now.getHours() < config.assistantHour) return;
	const last = load().lastRunAt;
	if (last && new Date(last).toDateString() === now.toDateString()) return;
	void runAssistant('daily').catch((err) => console.error('[Assistant]', (err as Error).message));
}

let dailyTimer: NodeJS.Timeout | null = null;
// Il primo controllo aspetta un po' dopo l'avvio: le letture dei sensori devono
// essere arrivate, o l'assistente vedrebbe tutte le piante senza dati.
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
const CHECK_EVERY_MS = 5 * 60 * 1000;

/** Indipendente dallo scheduler MQTT: l'assistente deve girare anche senza broker. */
export function startAssistant(): void {
	if (dailyTimer || !isAssistantEnabled()) {
		if (!isAssistantEnabled()) console.log('[Assistant] Disabled (no Gemini API key)');
		return;
	}
	const first = setTimeout(() => {
		maybeRunDaily();
		dailyTimer = setInterval(() => maybeRunDaily(), CHECK_EVERY_MS);
		dailyTimer.unref();
	}, FIRST_CHECK_DELAY_MS);
	first.unref();
	console.log(`[Assistant] Enabled (${config.geminiModel}), daily check from ${config.assistantHour}:00`);
}

export function stopAssistant(): void {
	if (dailyTimer) clearInterval(dailyTimer);
	dailyTimer = null;
}

function findCard(id: string): AssistantCard {
	const card = load().cards.find((c) => c.id === id);
	if (!card) throw new Error('NOT_FOUND');
	return card;
}

function touch(card: AssistantCard): AssistantState {
	card.updatedAt = new Date().toISOString();
	save();
	publishState();
	return getAssistantState();
}

export function answerCard(id: string, answer: string): AssistantState {
	const card = findCard(id);
	const text = cleanText(answer, 120);
	if (!text) throw new Error('BAD_REQUEST');
	card.answer = text;
	card.status = 'answered';
	return touch(card);
}

export function applyCard(id: string): AssistantState {
	const card = findCard(id);
	if (!card.action || !card.plantId || card.status !== 'open') throw new Error('BAD_REQUEST');
	card.previous = applyAction(card.plantId, card.action);
	card.status = 'applied';
	return touch(card);
}

export function undoCard(id: string): AssistantState {
	const card = findCard(id);
	if (!card.action || !card.plantId || card.status !== 'applied') throw new Error('BAD_REQUEST');
	undoAction(card.plantId, card.action, card.previous);
	card.status = 'undone';
	return touch(card);
}

export function dismissCard(id: string): AssistantState {
	const card = findCard(id);
	card.status = 'dismissed';
	return touch(card);
}
