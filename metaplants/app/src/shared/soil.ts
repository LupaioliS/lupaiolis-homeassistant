import type { PlantSensors, SensorSample, WateringPrediction } from './types';

/**
 * Chi decide che il terreno è secco, in un posto solo.
 *
 * La lettura grezza del sensore non è confrontabile nel tempo: i capacitivi
 * derivano, e la soglia scritta a mano ("innaffia sotto il 30%") invecchia con
 * loro — fra qualche settimana lo stesso terreno secco legge 38% e l'allerta non
 * arriva più, o arriva sempre. La scala imparata dalle irrigazioni vere invece si
 * ritara ad ogni innaffiatura confermata, quindi è quella a comandare: 0% sulla
 * scala IA significa "sei al livello a cui innaffi di solito", qualunque numero
 * grezzo ci corrisponda oggi.
 *
 * La soglia manuale resta come innesco finché la scala non è stata imparata.
 */

// Livello della scala calibrata sotto il quale la pianta va innaffiata. È 0 per
// definizione: lo zero della scala È il punto in cui di solito innaffi.
export const AI_DRY_LEVEL = 0;

/** Massimo osservato per il campione: il picco se registrato, altrimenti il valore. */
export function samplePeak(sample: SensorSample): number {
	return sample.peak ?? sample.v;
}

/** Minimo osservato per il campione: la conca se registrata, altrimenti il valore. */
export function sampleTrough(sample: SensorSample): number {
	return sample.trough ?? sample.v;
}

// Finestra su cui si cerca il minimo con cui confrontare una lettura per decidere
// se è una risalita. Stesso valore usato dal rilevamento in server/sensors.ts.
export const RISE_WINDOW_MS = 45 * 60 * 1000;
// Risalita, in punti percentuali, che fa sospettare un'irrigazione.
export const DEFAULT_RISE_DELTA = 10;
// Due risalite più vicine di così sono lo stesso evento (il terreno resta bagnato).
const RISE_MERGE_MS = 12 * 60 * 60 * 1000;

/**
 * Gli istanti in cui il terreno è risalito di colpo, cioè quando è arrivata acqua.
 *
 * È la stessa forma di curva che `sensors.ts` usa per chiedere "hai innaffiato?",
 * ma qui applicata a posteriori su una serie: serve alla calibrazione per sapere
 * DOVE è arrivata l'acqua invece di fidarsi dell'orario in cui hai premuto il
 * pulsante, e al grafico per marcare le risalite che nessuno ha confermato.
 *
 * Restituisce gli indici nella serie ricevuta, in ordine cronologico.
 */
export function findRises(samples: SensorSample[], delta = DEFAULT_RISE_DELTA): number[] {
	const rises: number[] = [];
	for (let i = 1; i < samples.length; i++) {
		let baseline = Infinity;
		for (let j = i - 1; j >= 0 && samples[i].t - samples[j].t <= RISE_WINDOW_MS; j--) {
			baseline = Math.min(baseline, sampleTrough(samples[j]));
		}
		if (!Number.isFinite(baseline)) continue;
		if (samplePeak(samples[i]) - baseline < delta) continue;
		if (rises.length > 0 && samples[i].t - samples[rises[rises.length - 1]].t < RISE_MERGE_MS) continue;
		rises.push(i);
	}
	return rises;
}

export type SoilSignalSource = 'ai' | 'raw' | 'none';

export interface SoilSignal {
	/** Il terreno chiede acqua adesso. */
	needsWater: boolean;
	/** 'ai' = scala calibrata, 'raw' = soglia manuale sulla lettura grezza, 'none' = nessun sensore. */
	source: SoilSignalSource;
	/** Lettura riportata sulla scala della pianta (0-100), se c'è una calibrazione. */
	normalized: number | null;
	/** Lettura grezza del sensore. */
	raw: number | null;
	/** Soglia manuale configurata, se c'è. */
	threshold: number | null;
	/** true = la scala viene da irrigazioni vere, non dalla soglia scritta a mano. */
	learned: boolean;
}

export function assessSoil(
	sensors: PlantSensors | undefined,
	soilHumidity: number | null | undefined,
	prediction: WateringPrediction | null | undefined,
): SoilSignal {
	const raw = soilHumidity ?? null;
	const threshold = sensors?.soilHumidityThreshold ?? null;
	const calibration = prediction?.calibration ?? null;
	const normalized = calibration ? prediction?.normalizedSoilHumidity ?? null : null;
	const learned = (calibration?.samples ?? 0) > 0;

	if (normalized != null) {
		return { needsWater: normalized <= AI_DRY_LEVEL, source: 'ai', normalized, raw, threshold, learned };
	}
	if (threshold != null && raw != null) {
		return { needsWater: raw <= threshold, source: 'raw', normalized: null, raw, threshold, learned: false };
	}
	return { needsWater: false, source: 'none', normalized: null, raw, threshold, learned: false };
}
