import type { Plant, PlantReadings, Season, WateringPrediction } from '../shared/types';
import { describeDue, getIntervalForSeason, type DueInfo } from '../shared/schedule';
import { assessSoil, type SoilSignal } from '../shared/soil';

// Sotto questa soglia la stima è considerata "adesso" invece di "fra pochi minuti".
const DUE_NOW_DAYS = 0.05;

export interface WaterAssessment {
	/** Va innaffiata adesso. */
	overdue: boolean;
	/** Chi ha deciso: terreno (scala IA o soglia grezza), stima interna o programma stagionale. */
	source: 'soil' | 'prediction' | 'schedule';
	/** Scadenza da programma stagionale, sempre calcolata (fa da riferimento). */
	due: DueInfo;
	intervalDays: number;
	/** Segnale del terreno, calcolato in shared/soil.ts insieme al server. */
	soil: SoilSignal;
	/** Lettura grezza del terreno, se c'è un sensore. */
	soilHumidity: number | null;
	/** Il terreno chiede acqua adesso (dalla % IA quando c'è una scala calibrata). */
	soilNeedsWater: boolean;
	prediction: WateringPrediction | null;
	/** true quando la stima è abbastanza matura da guidare lo stato mostrato. */
	predictionLeads: boolean;
}

/**
 * Decide cosa mostrare per l'irrigazione, in un solo posto, così scheda e banner
 * "hanno bisogno di attenzioni" non possono più dire cose diverse.
 *
 * Ordine di precedenza:
 *  1. terreno secco — ma sulla scala calibrata dalle irrigazioni vere, non sulla
 *     lettura grezza: il sensore deriva, la scala si ritara ad ogni innaffiatura
 *     registrata (vedi shared/soil.ts). La soglia manuale resta l'innesco finché
 *     non c'è ancora una scala;
 *  2. stima interna, ma solo quando ha imparato abbastanza (confidence "high");
 *  3. programma stagionale.
 */
export function assessWater(plant: Plant, readings: PlantReadings | undefined, season: Season): WaterAssessment {
	const intervalDays = getIntervalForSeason(plant.wateringSchedule, season, plant.wateringIntervalDays ?? 3);
	const due = describeDue(plant.lastWatered, intervalDays);

	const prediction = readings?.prediction ?? null;
	const soil = assessSoil(plant.sensors, readings?.soilHumidity, prediction);
	const predictionLeads = prediction != null && prediction.confidence === 'high';
	const common = {
		due,
		intervalDays,
		soil,
		soilHumidity: soil.raw,
		soilNeedsWater: soil.needsWater,
		prediction,
		predictionLeads,
	};

	if (soil.needsWater) {
		return { overdue: true, source: 'soil', ...common };
	}
	if (predictionLeads && prediction) {
		return { overdue: prediction.daysLeft <= DUE_NOW_DAYS, source: 'prediction', ...common };
	}
	return { overdue: due.overdue, source: 'schedule', ...common };
}

export function isPredictionDueNow(prediction: WateringPrediction): boolean {
	return prediction.daysLeft <= DUE_NOW_DAYS;
}
