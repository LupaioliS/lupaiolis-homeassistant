import { store } from './store';
import { getEntityState, isHaAvailable } from './homeassistant';
import { broadcast } from './events';
import { config } from './config';
import { recordSample, getSamples, seedLegacySamples } from './history';
import { predictWatering, previewDryPoint } from './predict';
import { findRises, isValidSoilReading } from '../shared/soil';
import { Plant, PlantReadings, PlantSensors } from '../shared/types';

// Quanto indietro guardare per trovare una risalita: il minimo prima del salto
// (RISE_WINDOW_MS) più il tempo che serve a confermarla (fino a RISE_CONFIRM_MAX_MS).
const SOIL_JUMP_LOOKBACK_MS = 4 * 60 * 60 * 1000;
// Dopo un salto rilevato (o un'irrigazione registrata) il terreno resta bagnato:
// in questo periodo non si chiede di nuovo conferma.
const SOIL_JUMP_COOLDOWN_MS = 12 * 60 * 60 * 1000;

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

function hasSensors(plant: Plant): boolean {
	const s = plant.sensors;
	return Boolean(s?.temperature || s?.ambientHumidity || s?.soilHumidity);
}

/**
 * Un'irrigazione registrata (o un salto già segnalato) di recente rende inutile
 * chiedere di nuovo: il terreno è bagnato per ragioni note.
 */
function inJumpCooldown(plant: Plant, now: number): boolean {
	const marks = [plant.lastWatered, plant.sensors?.lastSoilJumpAt];
	return marks.some((mark) => {
		if (!mark) return false;
		const t = new Date(mark).getTime();
		return Number.isFinite(t) && now - t < SOIL_JUMP_COOLDOWN_MS;
	});
}

/**
 * Rileva l'irrigazione dalla forma della curva, non dalla soglia.
 *
 * La versione precedente chiedeva che la lettura precedente fosse SOTTO la soglia
 * di irrigazione: se innaffiavi prima che il terreno si asciugasse del tutto — cioè
 * quasi sempre — il salto non veniva mai rilevato. Qui basta una risalita marcata
 * rispetto al minimo recente, che la soglia sia configurata o no.
 *
 * È la stessa `findRises` di calibrazione e grafico, non una copia: quindi chiede
 * solo di salti che durano almeno mezz'ora. I disturbi del sensore (su e giù nel
 * giro di un quarto d'ora) facevano partire la domanda senza che nessuno avesse
 * dato acqua.
 */
function detectJump(plant: Plant, now: number): boolean {
	if (plant.sensors?.soilJumpPendingAck) return false; // già in attesa di risposta
	if (inJumpCooldown(plant, now)) return false;

	const recent = getSamples(plant.id, 'soil', now - SOIL_JUMP_LOOKBACK_MS);
	return findRises(recent, plant.sensors?.soilJumpDelta).length > 0;
}

function computePrediction(plant: Plant, currentSoil: number | null) {
	try {
		return predictWatering(plant, store.getActions(plant.id), currentSoil);
	} catch (err) {
		console.error(`[Predict] Failed for ${plant.name}:`, (err as Error).message);
		return null;
	}
}

async function readPlant(plant: Plant): Promise<void> {
	const s = plant.sensors;
	if (!hasSensors(plant)) return;

	const [temp, ambientHum, soilHum] = await Promise.all([
		s?.temperature ? getEntityState(s.temperature) : Promise.resolve(null),
		s?.ambientHumidity ? getEntityState(s.ambientHumidity) : Promise.resolve(null),
		s?.soilHumidity ? getEntityState(s.soilHumidity) : Promise.resolve(null),
	]);

	const now = Date.now();
	// Una lettura impossibile (448%, 0 da sensore staccato) vale come sensore non
	// disponibile: non finisce nello storico, non fa scattare l'allerta e non
	// sembra un'irrigazione al rientro sul valore vero.
	const soilValue = isValidSoilReading(soilHum?.value) ? soilHum!.value : null;
	if (soilHum?.value != null && soilValue == null) {
		console.warn(`[Sensors] Ignored invalid soil reading for '${plant.name}': ${soilHum.value}`);
	}
	if (temp?.value != null) recordSample(plant.id, 'temp', temp.value, now);
	if (ambientHum?.value != null) recordSample(plant.id, 'hum', ambientHum.value, now);
	if (soilValue != null) recordSample(plant.id, 'soil', soilValue, now);

	const next: PlantReadings = {
		temperature: temp?.value ?? null,
		ambientHumidity: ambientHum?.value ?? null,
		soilHumidity: soilValue,
		updatedAt: new Date(now).toISOString(),
		prediction: computePrediction(plant, soilValue),
		// Cosa imparerebbe la scala se registrassi un'irrigazione adesso: esiste anche
		// quando la previsione non c'è ancora, che è quando serve di più saperlo.
		nextDryPoint: s?.soilHumidity ? previewDryPoint(plant, now) : null,
	};

	readings.set(plant.id, next);
	broadcast({ type: 'plant-readings', plantId: plant.id, readings: next });
	onReadingsUpdated?.(plant);

	if (soilValue == null || !s?.soilHumidity) return;

	// plants.json viene riscritto solo quando cambia qualcosa di persistente:
	// lo storico ora vive in history.db (history.ts), quindi il poll normale non tocca il disco.
	const jumped = detectJump(plant, now);
	const baselineChanged = s.lastSoilHumidity == null || Math.abs(s.lastSoilHumidity - soilValue) >= 1;
	if (!jumped && !baselineChanged) return;

	const updatedSensors: PlantSensors = { ...s, lastSoilHumidity: soilValue };
	if (jumped) {
		updatedSensors.soilJumpPendingAck = true;
		updatedSensors.lastSoilJumpAt = new Date(now).toISOString();
	}

	const updated = store.updatePlant(plant.id, { sensors: updatedSensors });
	if (updated && jumped) {
		console.log(`[Sensors] Soil jump detected for '${plant.name}' (${soilValue}%)`);
		broadcast({ type: 'soil-humidity-jumped', plantId: plant.id });
		broadcast({ type: 'plant-updated', plant: updated });
	}
}

async function pollOnce(): Promise<void> {
	// In parallelo: in sequenza il ritardo dell'ultima pianta era la somma di
	// tutte le chiamate HTTP a Home Assistant fatte prima di lei.
	await Promise.all(store.getPlants().filter(hasSensors).map((plant) => readPlant(plant)));
}

export async function refreshPlantReadings(plant: Plant): Promise<void> {
	if (!isHaAvailable()) return; // no token = no-op
	await readPlant(plant);
}

/**
 * Ricalcola la stima dopo un'azione dell'utente (es. innaffiatura) senza aspettare
 * il prossimo poll: l'irrigazione appena registrata cambia sia il ciclo medio che
 * il punto di partenza della curva di asciugatura.
 */
export function refreshPrediction(plant: Plant): void {
	const current = readings.get(plant.id);
	if (!current) return;
	const next: PlantReadings = {
		...current,
		prediction: computePrediction(plant, current.soilHumidity),
		nextDryPoint: plant.sensors?.soilHumidity ? previewDryPoint(plant) : null,
	};
	readings.set(plant.id, next);
	broadcast({ type: 'plant-readings', plantId: plant.id, readings: next });
}

/**
 * Porta nello storico (history.ts) i 10 campioni per sensore che le versioni <= 1.9.3
 * tenevano dentro plants.json, e ripulisce i campi ormai inutilizzati.
 */
export function migrateLegacySensorHistory(): void {
	for (const plant of store.getPlants()) {
		const s = plant.sensors;
		if (!s) continue;
		if (!s.temperatureHistory && !s.ambientHumidityHistory && !s.soilHumidityHistory) continue;

		if (s.soilHumidityHistory?.length) seedLegacySamples(plant.id, 'soil', s.soilHumidityHistory);
		if (s.temperatureHistory?.length) seedLegacySamples(plant.id, 'temp', s.temperatureHistory);
		if (s.ambientHumidityHistory?.length) seedLegacySamples(plant.id, 'hum', s.ambientHumidityHistory);

		const cleaned: PlantSensors = { ...s };
		delete cleaned.temperatureHistory;
		delete cleaned.ambientHumidityHistory;
		delete cleaned.soilHumidityHistory;
		store.updatePlant(plant.id, { sensors: cleaned });
		console.log(`[History] Migrated legacy sensor history for '${plant.name}'`);
	}
}

export function startSensorPolling(intervalMs = config.sensorPollSeconds * 1000): void {
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
