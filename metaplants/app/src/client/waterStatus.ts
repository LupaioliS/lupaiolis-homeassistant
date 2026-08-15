import type { Plant, PlantReadings, Season, WateringPrediction } from '../shared/types';
import { describeDue, getIntervalForSeason, type DueInfo } from '../shared/schedule';

// Sotto questa soglia la stima è considerata "adesso" invece di "fra pochi minuti".
const DUE_NOW_DAYS = 0.05;

export interface WaterAssessment {
	/** Va innaffiata adesso. */
	overdue: boolean;
	/** Chi ha deciso: sensore sotto soglia, stima interna o programma stagionale. */
	source: 'soil' | 'prediction' | 'schedule';
	/** Scadenza da programma stagionale, sempre calcolata (fa da riferimento). */
	due: DueInfo;
	intervalDays: number;
	/** Lettura grezza del terreno, se c'è un sensore. */
	soilHumidity: number | null;
	soilBelowThreshold: boolean;
	prediction: WateringPrediction | null;
	/** true quando la stima è abbastanza matura da guidare lo stato mostrato. */
	predictionLeads: boolean;
}

/**
 * Decide cosa mostrare per l'irrigazione, in un solo posto, così scheda e banner
 * "hanno bisogno di attenzioni" non possono più dire cose diverse.
 *
 * Ordine di precedenza:
 *  1. sensore terreno sotto la soglia impostata a mano — è un dato di fatto;
 *  2. stima interna, ma solo quando ha imparato abbastanza (confidence "high");
 *  3. programma stagionale.
 */
export function assessWater(plant: Plant, readings: PlantReadings | undefined, season: Season): WaterAssessment {
	const intervalDays = getIntervalForSeason(plant.wateringSchedule, season, plant.wateringIntervalDays ?? 3);
	const due = describeDue(plant.lastWatered, intervalDays);

	const threshold = plant.sensors?.soilHumidityThreshold;
	const soilHumidity = readings?.soilHumidity ?? null;
	const soilBelowThreshold = threshold != null && soilHumidity != null && soilHumidity <= threshold;

	const prediction = readings?.prediction ?? null;
	const predictionLeads = prediction != null && prediction.confidence === 'high';

	if (soilBelowThreshold) {
		return { overdue: true, source: 'soil', due, intervalDays, soilHumidity, soilBelowThreshold, prediction, predictionLeads };
	}
	if (predictionLeads && prediction) {
		return {
			overdue: prediction.daysLeft <= DUE_NOW_DAYS,
			source: 'prediction',
			due,
			intervalDays,
			soilHumidity,
			soilBelowThreshold,
			prediction,
			predictionLeads,
		};
	}
	return { overdue: due.overdue, source: 'schedule', due, intervalDays, soilHumidity, soilBelowThreshold, prediction, predictionLeads };
}

export function isPredictionDueNow(prediction: WateringPrediction): boolean {
	return prediction.daysLeft <= DUE_NOW_DAYS;
}
