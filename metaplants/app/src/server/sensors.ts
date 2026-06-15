import { store } from './store';
import { getEntityState, isHaAvailable } from './homeassistant';
import { broadcast } from './events';
import { PlantReadings } from '../shared/types';


const readings = new Map<string, PlantReadings>(); // plantId -> ultimi valori
let timer: NodeJS.Timeout | null = null;

export function getReadings(plantId: string): PlantReadings | undefined {
	return readings.get(plantId);
}

async function pollOnce(): Promise<void> {
	for (const plant of store.getPlants()) {
		const s = plant.sensors;
		if (!s?.temperature && !s?.humidity) continue;

		const [temp, hum] = await Promise.all([
			s?.temperature ? getEntityState(s.temperature) : Promise.resolve(null),
			s?.humidity ? getEntityState(s.humidity) : Promise.resolve(null),
		]);

		const next: PlantReadings = {
			temperature: temp?.value ?? null,
			humidity: hum?.value ?? null,
			updatedAt: new Date().toISOString(),
		};

		readings.set(plant.id, next);
		broadcast({ type: 'plant-readings', plantId: plant.id, readings: next });
	}
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