import { store } from './store';
import { getEntityState, isHaAvailable } from './homeassistant';
import { broadcast } from './events';
import { Plant, PlantReadings, PlantSensors } from '../shared/types';

// Minimum % above threshold to consider a jump (plant likely received water)
const SOIL_JUMP_DELTA = 20;


const readings = new Map<string, PlantReadings>(); // plantId -> ultimi valori
let timer: NodeJS.Timeout | null = null;

// Iniettato da index.ts per evitare un import circolare con mqtt.ts: senza questo,
// le letture sensori e il republish MQTT girano su due timer indipendenti e possono
// disallinearsi fino a un intero ciclo di polling.
let onReadingsUpdated: ((plant: Plant) => void) | null = null;

export function setOnReadingsUpdated(callback: (plant: Plant) => void): void {
	onReadingsUpdated = callback;
}

export function getReadings(plantId: string): PlantReadings | undefined {
	return readings.get(plantId);
}

export function getAllReadings(): Record<string, PlantReadings> {
	return Object.fromEntries(readings);
}

async function readPlant(plant: Plant): Promise<void> {
	const s = plant.sensors;
	if (!s?.temperature && !s?.ambientHumidity && !s?.soilHumidity) return;

	const [temp, ambientHum, soilHum] = await Promise.all([
		s?.temperature ? getEntityState(s.temperature) : Promise.resolve(null),
		s?.ambientHumidity ? getEntityState(s.ambientHumidity) : Promise.resolve(null),
		s?.soilHumidity ? getEntityState(s.soilHumidity) : Promise.resolve(null),
	]);

	const next: PlantReadings = {
		temperature: temp?.value ?? null,
		ambientHumidity: ambientHum?.value ?? null,
		soilHumidity: soilHum?.value ?? null,
		updatedAt: new Date().toISOString(),
	};

	readings.set(plant.id, next);
	broadcast({ type: 'plant-readings', plantId: plant.id, readings: next });
	onReadingsUpdated?.(plant);

	// Persist soil reading and detect jumps server-side
	if (s.soilHumidity && soilHum?.value != null) {
		const current = soilHum.value;
		const threshold = s.soilHumidityThreshold;
		const prev = s.lastSoilHumidity;

		const jumped =
			threshold != null &&
			prev != null &&
			prev <= threshold &&
			current >= threshold + SOIL_JUMP_DELTA &&
			!s.soilJumpPendingAck; // don't re-detect if already awaiting ack

		const updatedSensors: PlantSensors = {
			...s,
			lastSoilHumidity: current,
			...(jumped ? { soilJumpPendingAck: true } : {}),
		};

		const updated = store.updatePlant(plant.id, { sensors: updatedSensors });
		if (updated && jumped) {
			broadcast({ type: 'soil-humidity-jumped', plantId: plant.id });
			broadcast({ type: 'plant-updated', plant: updated });
		}
	}
}

async function pollOnce(): Promise<void> {
	for (const plant of store.getPlants()) {
		await readPlant(plant);
	}
}

export async function refreshPlantReadings(plant: Plant): Promise<void> {
	if (!isHaAvailable()) return; // no token = no-op
	await readPlant(plant);
}

export function startSensorPolling(intervalMs = 60_000): void {
	if (timer || !isHaAvailable()) return; // niente token = niente polling
	void pollOnce();                        // lettura immediata all'avvio
	timer = setInterval(() => void pollOnce(), intervalMs);
	timer.unref();
	console.log(`[Sensors] Polling started (every ${intervalMs} ms)`);
}

export function stopSensorPolling(): void {
	if (!timer) return;
	clearInterval(timer);
	timer = null;
	console.log('[Sensors] Polling stopped');
}