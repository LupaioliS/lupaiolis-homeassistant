import type { PlantSensors, WateringPrediction } from './types';

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
