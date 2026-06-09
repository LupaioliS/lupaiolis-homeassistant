import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Plant, PlantAction, HealthIssue, ProductUsage } from '../shared/types';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
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
		return removed;
	},

	addAction: (plantId: string, type: 'water' | 'fertilize' | 'repot' | 'prune', notes?: string): PlantAction | undefined => {
		const plants = readPlants();
		const plantIndex = plants.findIndex((p) => p.id === plantId);
		if (plantIndex === -1) return undefined;

		const action: PlantAction = {
			id: randomUUID(),
			plantId,
			type,
			date: new Date().toISOString(),
			notes,
		};

		switch (type) {
			case 'water':
				plants[plantIndex].lastWatered = action.date;
				break;
			case 'fertilize':
				plants[plantIndex].lastFertilized = action.date;
				break;
			case 'repot':
				plants[plantIndex].lastRepotted = action.date;
				break;
			case 'prune':
				plants[plantIndex].lastPruned = action.date;
				break;
		}
		writePlants(plants);

		const actions = readActions();
		actions.push(action);
		writeActions(actions);

		return action;
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
};
