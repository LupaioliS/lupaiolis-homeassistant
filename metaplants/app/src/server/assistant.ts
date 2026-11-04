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
	return `You are the daily plant-care assistant of MetaPlants, a home plant tracker. You get a JSON snapshot of the user's plants once a day and reply with a few short cards. Write every title, body and option in ${language}, in a friendly, concrete tone.

How the data works:
- watering.scheduleDays / fertilizing.scheduleDays are per-season intervals in days; watering.currentDays is today's.
- Plants with soilSensor are driven by the sensor, not the calendar: plantScalePercent 0 means "at the level this plant is usually watered", 100 means "soil as wet as after a watering". Do not tell the user to water a sensor plant whose plantScalePercent is above 0 just because days have passed.
- Plants without a soil sensor get finger tests: "moist"/"wet" results mean the user checked and it did not need water yet.
- previousCards are your cards of the last days, with the user's answers and what happened. Use the answers, don't repeat a card the user dismissed or answered, and don't ask the same question again.

What to produce (0 to ${MAX_CARDS_PER_RUN} cards; zero is fine on a quiet day — never pad):
- "advice": a useful observation or tip tied to the data (season change, a plant drying faster than its schedule, fertilizing in the rest season, a health issue open for long, repotting overdue for the species).
- "question": when an answer from the user would change your advice. Give 2-4 short options. IMPORTANT: if a card asks the user anything, it MUST be a "question" with options — an "advice" card must never end with a question, because the user has no way to answer it.
- For a health issue open for weeks, prefer an "action" card with resolve_health_issue (the user confirms if it's gone) over asking in free text.
- "action": a concrete change to the app's data. Whenever you suggest a change that this catalog can make (e.g. "let's move it to 21 days"), it MUST be an "action" card with the action object fully filled and plantId set — never put such a proposal only in the text of an advice card, the user would have no button to apply it. Use only this catalog, with these fields (season is required for schedules: use today's season if the change is for now):
  - set_watering_schedule {season, value: days 1-90}
  - set_fertilizing_schedule {season, value: days 1-180}
  - set_soil_threshold {value: raw % 1-90} — only for plants with a soil sensor and learnedFromWaterings = 0
  - add_health_issue {issueType: pest|disease|fungus, issueName: one of ${JSON.stringify(HEALTH_NAMES)}, text: notes}
  - resolve_health_issue {issueId, text: treatment}
  - append_note {text: max 300 chars}
  Set autoApply true only for small, low-risk changes you are confident about (e.g. nudging a schedule by a day or two to match how the plant really behaves). The app may still ask the user to confirm. Anything about health always needs confirmation: autoApply false.
- Always set plantId to the plant's id when the card is about one plant ("all" only for cards about every plant), and always fill action: {type: "none"} when the card proposes no change. Be specific: name the plant and the numbers that support the advice. Keep body under 280 characters.
- Never invent events (waterings, pests) that are not in the data, and never propose logging a watering or fertilizing: only the user knows what they did.`;
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
		required: ['cards'],
	};
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
		const parsed = JSON.parse(text) as { cards?: RawCard[] };
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
