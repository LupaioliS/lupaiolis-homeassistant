import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Plant, PlantAction } from '../shared/types';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const PLANTS_FILE = path.join(DATA_DIR, 'plants.json');
const ACTIONS_FILE = path.join(DATA_DIR, 'actions.json');

function ensureDataDir() {
	if (!fs.existsSync(DATA_DIR)) {
		fs.mkdirSync(DATA_DIR, { recursive: true });
	}
}

function readPlants(): Plant[] {
	ensureDataDir();
	if (!fs.existsSync(PLANTS_FILE)) return [];
	const data = fs.readFileSync(PLANTS_FILE, 'utf-8');
	return JSON.parse(data);
}

function writePlants(plants: Plant[]) {
	ensureDataDir();
	fs.writeFileSync(PLANTS_FILE, JSON.stringify(plants, null, '	'));
}

function readActions(): PlantAction[] {
	ensureDataDir();
	if (!fs.existsSync(ACTIONS_FILE)) return [];
	const data = fs.readFileSync(ACTIONS_FILE, 'utf-8');
	return JSON.parse(data);
}

function writeActions(actions: PlantAction[]) {
	ensureDataDir();
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

	addAction: (plantId: string, type: 'water' | 'fertilize', notes?: string): PlantAction | undefined => {
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

		if (type === 'water') {
			plants[plantIndex].lastWatered = action.date;
		} else {
			plants[plantIndex].lastFertilized = action.date;
		}
		writePlants(plants);

		const actions = readActions();
		actions.push(action);
		writeActions(actions);

		return action;
	},

	getActions: (plantId: string): PlantAction[] => {
		return readActions().filter((a) => a.plantId === plantId);
	},
};
