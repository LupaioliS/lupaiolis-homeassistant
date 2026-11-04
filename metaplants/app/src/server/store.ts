import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Plant, PlantAction, PlantActionOptions, PlantActionPatch, HealthIssue, ProductUsage } from '../shared/types';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'));
const PLANTS_FILE = path.join(DATA_DIR, 'plants.json');
const ACTIONS_FILE = path.join(DATA_DIR, 'actions.json');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

function ensureDataDir() {
	if (!fs.existsSync(DATA_DIR)) {
		fs.mkdirSync(DATA_DIR, { recursive: true });
	}
}

export function ensureUploadsDir() {
	if (!fs.existsSync(UPLOADS_DIR)) {
		fs.mkdirSync(UPLOADS_DIR, { recursive: true });
	}
}

function deleteUpload(imageUrl?: string) {
	if (!imageUrl) return;
	// Stored as "uploads/<filename>" — only delete files inside UPLOADS_DIR
	const filename = path.basename(imageUrl);
	if (!imageUrl.startsWith('uploads/') || !filename) return;
	const file = path.join(UPLOADS_DIR, filename);
	if (fs.existsSync(file)) {
		try {
			fs.unlinkSync(file);
		} catch {
			/* ignore */
		}
	}
}

// In-memory caches to avoid disk reads on every request
let plantsCache: Plant[] | null = null;
let actionsCache: PlantAction[] | null = null;

function readPlants(): Plant[] {
	if (plantsCache) return plantsCache;
	ensureDataDir();
	if (!fs.existsSync(PLANTS_FILE)) {
		plantsCache = [];
		return plantsCache;
	}
	const data = fs.readFileSync(PLANTS_FILE, 'utf-8');
	plantsCache = JSON.parse(data);
	return plantsCache!;
}

function writePlants(plants: Plant[]) {
	ensureDataDir();
	plantsCache = plants;
	fs.writeFileSync(PLANTS_FILE, JSON.stringify(plants, null, '	'));
}

function readActions(): PlantAction[] {
	if (actionsCache) return actionsCache;
	ensureDataDir();
	if (!fs.existsSync(ACTIONS_FILE)) {
		actionsCache = [];
		return actionsCache;
	}
	const data = fs.readFileSync(ACTIONS_FILE, 'utf-8');
	actionsCache = JSON.parse(data);
	return actionsCache!;
}

function writeActions(actions: PlantAction[]) {
	ensureDataDir();
	actionsCache = actions;
	fs.writeFileSync(ACTIONS_FILE, JSON.stringify(actions, null, '	'));
}
type ActionType = PlantAction['type'];

const LAST_DONE_FIELD = {
	water: 'lastWatered',
	fertilize: 'lastFertilized',
	repot: 'lastRepotted',
	prune: 'lastPruned',
} as const satisfies Record<Exclude<ActionType, 'check'>, keyof Plant>;

/** ISO normalizzato in UTC, o undefined se la data non sta in piedi. */
export function normalizeDate(value?: string | null): string | undefined {
	if (!value) return undefined;
	const time = new Date(value).getTime();
	return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/**
 * Riallinea `lastWatered` & co. allo storico azioni.
 *
 * Quelle date sono una copia denormalizzata dell'azione più recente: se una riga
 * viene spostata nel tempo o cancellata, senza questo la scheda continuerebbe a
 * mostrare un'irrigazione che non esiste più. Tocca solo i tipi passati, perché
 * rinvaso e potatura si possono impostare a mano dalla scheda senza azione.
 */
// Un'irrigazione registrata fino a tanto prima della risalita la spiega comunque:
// è la stessa finestra in cui la calibrazione cerca la risalita (predict.ts).
const SOIL_JUMP_ACTION_LAG_MS = 12 * 60 * 60 * 1000;

/**
 * Un'irrigazione registrata da qualunque parte (app, pulsante HA, MQTT) risponde
 * già alla domanda "hai innaffiato?" per la risalita che la segue o la precede di
 * poco. Prima lo decideva solo il client, e con "innaffiata oggi" invece che con
 * gli orari: una pioggia la sera dopo un'irrigazione al mattino veniva scartata
 * in silenzio, e un'irrigazione dal pulsante HA lasciava la domanda appesa per
 * giorni, bloccando il rilevamento delle successive.
 */
function clearAnsweredSoilJump(plantId: string, actionDate: string) {
	const plants = readPlants();
	const plant = plants.find((p) => p.id === plantId);
	const sensors = plant?.sensors;
	if (!plant || !sensors?.soilJumpPendingAck) return;
	const riseAt = new Date(sensors.soilJumpRiseAt ?? sensors.lastSoilJumpAt ?? '').getTime();
	const at = new Date(actionDate).getTime();
	if (Number.isFinite(riseAt) && at < riseAt - SOIL_JUMP_ACTION_LAG_MS) return;
	plant.sensors = { ...sensors, soilJumpPendingAck: false };
	writePlants(plants);
}

function syncLastDone(plantId: string, types: ActionType[]) {
	const plants = readPlants();
	const index = plants.findIndex((p) => p.id === plantId);
	if (index === -1) return;

	const plant = plants[index];
	for (const type of types) {
		if (type === 'check') {
			// Oltre alla data serve l'esito: è lui a decidere di quanto si rimanda.
			const latest = readActions()
				.filter((a) => a.plantId === plantId && a.type === 'check' && a.soil)
				.reduce<PlantAction | undefined>((max, a) => (max == null || a.date > max.date ? a : max), undefined);
			if (latest?.soil) plant.lastSoilCheck = { date: latest.date, soil: latest.soil };
			else delete plant.lastSoilCheck;
			continue;
		}
		const latest = readActions()
			.filter((a) => a.plantId === plantId && a.type === type)
			.reduce<string | undefined>((max, a) => (max == null || a.date > max ? a.date : max), undefined);
		const field = LAST_DONE_FIELD[type];
		if (latest) plant[field] = latest;
		else delete plant[field];
	}
	writePlants(plants);
}
export const store = {
	getPlants: (): Plant[] => readPlants(),

	getPlant: (id: string): Plant | undefined => {
		return readPlants().find((p) => p.id === id);
	},

	createPlant: (data: Omit<Plant, 'id' | 'createdAt'>): Plant => {
		const plants = readPlants();
		const plant: Plant = {
			...data,
			id: randomUUID(),
			createdAt: new Date().toISOString(),
		};
		plants.push(plant);
		writePlants(plants);
		return plant;
	},

	updatePlant: (id: string, data: Partial<Plant>): Plant | undefined => {
		const plants = readPlants();
		const index = plants.findIndex((p) => p.id === id);
		if (index === -1) return undefined;
		plants[index] = { ...plants[index], ...data, id };
		writePlants(plants);
		return plants[index];
	},

	deletePlant: (id: string): Plant | undefined => {
		const plants = readPlants();
		const index = plants.findIndex((p) => p.id === id);
		if (index === -1) return undefined;
		const [removed] = plants.splice(index, 1);
		writePlants(plants);

		// Remove associated actions
		const actions = readActions().filter((a) => a.plantId !== id);
		writeActions(actions);

		// Remove uploaded photos (plant + health issues)
		deleteUpload(removed.imageUrl);
		for (const issue of removed.healthIssues ?? []) {
			deleteUpload(issue.imageUrl);
		}

		return removed;
	},

	addAction: (plantId: string, type: ActionType, options?: PlantActionOptions): PlantAction | undefined => {
		const plants = readPlants();
		const plantIndex = plants.findIndex((p) => p.id === plantId);
		if (plantIndex === -1) return undefined;

		const action: PlantAction = {
			id: randomUUID(),
			plantId,
			type,
			date: normalizeDate(options?.date) ?? new Date().toISOString(),
			notes: options?.notes,
			// Quantità e provenienza descrivono solo l'acqua, l'esito solo la prova del dito.
			amount: type === 'water' ? options?.amount : undefined,
			amountMl: options?.amountMl,
			amountGrams: options?.amountGrams,
			potSizeCm: options?.potSizeCm,
			// Solo per l'acqua: sulle altre azioni non vuol dire niente.
			source: type === 'water' ? options?.source : undefined,
			soil: type === 'check' ? options?.soil : undefined,
		};

		if (type === 'repot' && options?.potSizeCm != null) {
			plants[plantIndex].potSizeCm = options.potSizeCm;
			writePlants(plants);
		}

		const actions = readActions();
		actions.push(action);
		writeActions(actions);
		syncLastDone(plantId, [type]);
		if (type === 'water') clearAnsweredSoilJump(plantId, action.date);

		return action;
	},

	updateAction: (id: string, patch: PlantActionPatch): PlantAction | undefined => {
		const actions = readActions();
		const index = actions.findIndex((a) => a.id === id);
		if (index === -1) return undefined;

		const updated: PlantAction = { ...actions[index] };
		const date = normalizeDate(patch.date);
		if (date) updated.date = date;
		if (patch.notes !== undefined) updated.notes = patch.notes ?? undefined;
		if (patch.amount !== undefined && updated.type === 'water') updated.amount = patch.amount ?? undefined;
		if (patch.amountMl !== undefined) updated.amountMl = patch.amountMl ?? undefined;
		if (patch.soil !== undefined && updated.type === 'check') updated.soil = patch.soil;
		if (patch.amountGrams !== undefined) updated.amountGrams = patch.amountGrams ?? undefined;
		if (patch.potSizeCm !== undefined) updated.potSizeCm = patch.potSizeCm ?? undefined;
		// La provenienza descrive solo l'acqua, e la calibrazione la legge: su un rinvaso
		// sarebbe rumore che finisce nello storico.
		if (patch.source !== undefined && updated.type === 'water') updated.source = patch.source ?? undefined;

		actions[index] = updated;
		writeActions(actions);
		syncLastDone(updated.plantId, [updated.type]);

		return updated;
	},

	deleteAction: (id: string): PlantAction | undefined => {
		const actions = readActions();
		const index = actions.findIndex((a) => a.id === id);
		if (index === -1) return undefined;
		const [removed] = actions.splice(index, 1);
		writeActions(actions);
		syncLastDone(removed.plantId, [removed.type]);
		return removed;
	},

	addHealthIssue: (plantId: string, issue: Omit<HealthIssue, 'id'>): HealthIssue | undefined => {
		const plants = readPlants();
		const plantIndex = plants.findIndex((p) => p.id === plantId);
		if (plantIndex === -1) return undefined;

		const healthIssue: HealthIssue = { ...issue, id: randomUUID() };
		if (!plants[plantIndex].healthIssues) plants[plantIndex].healthIssues = [];
		plants[plantIndex].healthIssues!.push(healthIssue);
		writePlants(plants);
		return healthIssue;
	},

	resolveHealthIssue: (plantId: string, issueId: string, treatment?: string): HealthIssue | undefined => {
		const plants = readPlants();
		const plantIndex = plants.findIndex((p) => p.id === plantId);
		if (plantIndex === -1) return undefined;

		const issues = plants[plantIndex].healthIssues ?? [];
		const issue = issues.find((i) => i.id === issueId);
		if (!issue) return undefined;

		issue.resolvedDate = new Date().toISOString();
		if (treatment) issue.treatment = treatment;
		writePlants(plants);
		return issue;
	},

	addProductUsage: (plantId: string, product: Omit<ProductUsage, 'id'>): ProductUsage | undefined => {
		const plants = readPlants();
		const plantIndex = plants.findIndex((p) => p.id === plantId);
		if (plantIndex === -1) return undefined;

		const usage: ProductUsage = { ...product, id: randomUUID() };
		if (!plants[plantIndex].productHistory) plants[plantIndex].productHistory = [];
		plants[plantIndex].productHistory!.push(usage);
		writePlants(plants);
		return usage;
	},

	getActions: (plantId: string): PlantAction[] => {
		return readActions().filter((a) => a.plantId === plantId);
	},

	getAction: (id: string): PlantAction | undefined => readActions().find((a) => a.id === id),

	getAllActions: (): PlantAction[] => readActions(),
};
