import { store } from './store';
import { getEntityState, isHaAvailable } from './homeassistant';
import { broadcast } from './events';
import { config } from './config';
import { recordSample, getSamples, getLastSample, seedLegacySamples } from './history';
import { predictWatering, previewDryPoint } from './predict';
import { findRises, isValidSoilReading } from '../shared/soil';
import { Plant, PlantReadings, PlantSensors } from '../shared/types';

// Quanto indietro guardare per trovare una risalita: il minimo prima del salto
// (RISE_WINDOW_MS) più il tempo che serve a confermarla (fino a RISE_CONFIRM_MAX_MS).
const SOIL_JUMP_LOOKBACK_MS = 4 * 60 * 60 * 1000;
// Dopo un salto rilevato (o un'irrigazione registrata) il terreno resta bagnato:
// in questo periodo non si chiede di nuovo conferma.
const SOIL_JUMP_COOLDOWN_MS = 12 * 60 * 60 * 1000;
// Una domanda rimasta senza risposta per così tanto non la vedrà più nessuno al
// momento giusto, e finché è aperta blocca il rilevamento delle successive.
const SOIL_JUMP_PENDING_MAX_MS = 3 * 24 * 60 * 60 * 1000;

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
function detectJump(plant: Plant, now: number): number | null {
	if (plant.sensors?.soilJumpPendingAck) return null; // già in attesa di risposta
	if (inJumpCooldown(plant, now)) return null;

	const recent = getSamples(plant.id, 'soil', now - SOIL_JUMP_LOOKBACK_MS);
	const rises = findRises(recent, plant.sensors?.soilJumpDelta);
	return rises.length > 0 ? recent[rises[rises.length - 1]].t : null;
}

function pendingExpired(sensors: PlantSensors, now: number): boolean {
	if (!sensors.soilJumpPendingAck) return false;
	const at = new Date(sensors.lastSoilJumpAt ?? '').getTime();
	return !Number.isFinite(at) || now - at > SOIL_JUMP_PENDING_MAX_MS;
}

// La stima legge tutto lo storico del terreno (~60 giorni): rifarla ogni 20s per
// ogni pianta, sul Pi, quando i campioni cambiano un bucket ogni 15 minuti, era
// lavoro buttato. Si rifà quando cambia la lettura, l'ultimo campione o la pianta,
// e comunque ogni PREDICTION_MAX_AGE_MS perché "fra N giorni" scorre col tempo.
const PREDICTION_MAX_AGE_MS = 5 * 60 * 1000;
interface PredictionMemo {
	key: string;
	at: number;
	prediction: PlantReadings['prediction'];
	nextDryPoint: number | null;
}
const predictionMemo = new Map<string, PredictionMemo>();

function memoKey(plant: Plant, currentSoil: number | null): string {
	const last = getLastSample(plant.id, 'soil');
	const s = plant.sensors;
	return [currentSoil, last?.t, last?.v, last?.peak, last?.trough, plant.lastWatered, s?.soilHumidityThreshold, s?.soilJumpDelta].join('|');
}

function computePrediction(plant: Plant, currentSoil: number | null, now: number, force = false): PredictionMemo {
	const key = memoKey(plant, currentSoil);
	const cached = predictionMemo.get(plant.id);
	if (!force && cached && cached.key === key && now - cached.at < PREDICTION_MAX_AGE_MS) return cached;

	let prediction: PlantReadings['prediction'] = null;
	try {
		prediction = predictWatering(plant, store.getActions(plant.id), currentSoil, now);
	} catch (err) {
		console.error(`[Predict] Failed for ${plant.name}:`, (err as Error).message);
	}
	// Cosa imparerebbe la scala se registrassi un'irrigazione adesso: esiste anche
	// quando la previsione non c'è ancora, che è quando serve di più saperlo.
	const nextDryPoint = plant.sensors?.soilHumidity ? previewDryPoint(plant, now, prediction?.calibration) : null;
	const memo = { key, at: now, prediction, nextDryPoint };
	predictionMemo.set(plant.id, memo);
	return memo;
}

async function readPlant(snapshot: Plant): Promise<void> {
	const asked = snapshot.sensors;
	if (!hasSensors(snapshot)) return;

	const [temp, ambientHum, soilHum] = await Promise.all([
		asked?.temperature ? getEntityState(asked.temperature) : Promise.resolve(null),
		asked?.ambientHumidity ? getEntityState(asked.ambientHumidity) : Promise.resolve(null),
		asked?.soilHumidity ? getEntityState(asked.soilHumidity) : Promise.resolve(null),
	]);

	// Le chiamate a HA possono durare: nel frattempo la pianta può essere stata
	// cancellata, modificata dal form, o la domanda "hai innaffiato?" può aver
	// avuto risposta. Si lavora sulla copia attuale, non su quella di prima: scrivere
	// `{...sensori vecchi}` rimetteva in piedi una domanda appena chiusa o annullava
	// il cambio di sensore appena salvato. E le letture di un'entità che nel
	// frattempo è stata cambiata non appartengono più a questa pianta.
	const plant = store.getPlant(snapshot.id);
	if (!plant) return;
	const s = plant.sensors;
	if (s?.temperature !== asked?.temperature || s?.ambientHumidity !== asked?.ambientHumidity || s?.soilHumidity !== asked?.soilHumidity) return;

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

	const { prediction, nextDryPoint } = computePrediction(plant, soilValue, now);
	const next: PlantReadings = {
		temperature: temp?.value ?? null,
		ambientHumidity: ambientHum?.value ?? null,
		soilHumidity: soilValue,
		updatedAt: new Date(now).toISOString(),
		prediction,
		nextDryPoint,
	};

	readings.set(plant.id, next);
	broadcast({ type: 'plant-readings', plantId: plant.id, readings: next });
	onReadingsUpdated?.(plant);

	if (soilValue == null || !s?.soilHumidity) return;

	// plants.json viene riscritto solo quando cambia qualcosa di persistente:
	// lo storico ora vive in history.db (history.ts), quindi il poll normale non tocca il disco.
	const expired = pendingExpired(s, now);
	const riseAt = expired ? null : detectJump(plant, now);
	const jumped = riseAt != null;
	const baselineChanged = s.lastSoilHumidity == null || Math.abs(s.lastSoilHumidity - soilValue) >= 1;
	if (!jumped && !baselineChanged && !expired) return;

	const updatedSensors: PlantSensors = { ...s, lastSoilHumidity: soilValue };
	if (expired) {
		updatedSensors.soilJumpPendingAck = false;
		console.log(`[Sensors] Unanswered soil jump for '${plant.name}' expired`);
	}
	if (jumped) {
		updatedSensors.soilJumpPendingAck = true;
		updatedSensors.lastSoilJumpAt = new Date(now).toISOString();
		updatedSensors.soilJumpRiseAt = new Date(riseAt).toISOString();
	}

	const updated = store.updatePlant(plant.id, { sensors: updatedSensors });
	if (updated && (jumped || expired)) {
		if (jumped) console.log(`[Sensors] Soil jump detected for '${plant.name}' (${soilValue}%)`);
		// La domanda viaggia dentro la pianta (soilJumpPendingAck): il client la
		// ricava dallo stato, quindi basta questo evento.
		broadcast({ type: 'plant-updated', plant: updated });
	}
}

let polling = false;

async function pollOnce(): Promise<void> {
	// Se HA è lento il giro precedente può non essere finito: partirne un altro
	// accumula richieste sul Pi senza dare letture più fresche.
	if (polling) return;
	polling = true;
	try {
		// In parallelo: in sequenza il ritardo dell'ultima pianta era la somma di
		// tutte le chiamate HTTP a Home Assistant fatte prima di lei.
		await Promise.all(store.getPlants().filter(hasSensors).map((plant) => readPlant(plant)));
	} finally {
		polling = false;
	}
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
	// Forzata: un'azione modificata o cancellata dalla tabella storico non cambia
	// la chiave della cache, ma cambia la stima.
	const { prediction, nextDryPoint } = computePrediction(plant, current.soilHumidity, Date.now(), true);
	const next: PlantReadings = { ...current, prediction, nextDryPoint };
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
