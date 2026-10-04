import type { CalibrationObservation, PlantAction, WaterAmount, WateringPrediction } from '../shared/types';

/**
 * Quanta acqua dare, senza ml.
 *
 * Nessuno misura l'acqua che versa: i ml nello storico erano quasi sempre il
 * valore proposto dallo slider. Tre livelli a occhio si scelgono senza pensarci,
 * e dove c'è un sensore del terreno si può verificare se bastavano: ogni
 * irrigazione osservata dice fin dove è arrivato il terreno rispetto al "pieno"
 * imparato (`CalibrationObservation.fill`, calcolato in server/predict.ts).
 */

export const WATER_AMOUNTS: WaterAmount[] = ['little', 'normal', 'lots'];

export const WATER_AMOUNT_EMOJI: Record<WaterAmount, string> = {
	little: '💧',
	normal: '💧💧',
	lots: '💧💧💧',
};

// Sotto questa percentuale del "pieno" la dose non è bastata a bagnare il vaso.
// Il pieno è il 75° percentile delle irrigazioni recenti: una bagnata normale ci
// arriva, una avara resta parecchio sotto.
export const FILL_ENOUGH = 85;

// Oltre questo tempo fra azione e osservazione non sono la stessa irrigazione.
const SAME_WATERING_MS = 60 * 1000;

export interface AmountFeedback {
	/** Quanta acqua era stata data, se registrato (le irrigazioni vecchie hanno solo i ml). */
	amount: WaterAmount | null;
	/** Fin dove è arrivato il terreno, 0-100 sulla scala della pianta. */
	fill: number;
	enough: boolean;
}

export interface AmountAdvice {
	/** La quantità da proporre la prossima volta. */
	suggested: WaterAmount;
	/** Come è andata l'ultima irrigazione vista dal sensore, se ce n'è una. */
	feedback: AmountFeedback | null;
}

function stepUp(amount: WaterAmount): WaterAmount {
	return amount === 'little' ? 'normal' : 'lots';
}

/** L'ultima irrigazione vista dal sensore e decisa da chi innaffia (la pioggia non conta). */
function lastObserved(prediction: WateringPrediction | null | undefined): CalibrationObservation | null {
	const observations = prediction?.calibration?.observations ?? [];
	for (let i = observations.length - 1; i >= 0; i--) {
		const o = observations[i];
		if (o.source !== 'rain' && o.fill != null) return o;
	}
	return null;
}

/**
 * Cosa proporre e cosa dire sulla quantità.
 *
 * Senza sensore si ripropone l'ultima quantità usata (o "normale"): non c'è modo di
 * sapere se bastava. Col sensore, se l'ultima irrigazione non ha riempito il vaso
 * si propone un livello in più; se l'ha riempito, la stessa.
 */
export function adviseAmount(
	actions: PlantAction[] | undefined,
	prediction: WateringPrediction | null | undefined,
	lastWatered?: string,
): AmountAdvice {
	const lastUsed = [...(actions ?? [])]
		.filter((a) => a.type === 'water' && a.amount && a.source !== 'rain')
		.sort((a, b) => a.date.localeCompare(b.date))
		.at(-1)?.amount ?? 'normal';

	const observed = lastObserved(prediction);
	// Il riscontro vale solo per l'ultima irrigazione: uno di tre cicli fa non dice
	// niente sulla dose di oggi.
	const isLatest = observed != null && lastWatered != null
		&& Math.abs(new Date(observed.at).getTime() - new Date(lastWatered).getTime()) < SAME_WATERING_MS;
	if (!observed || !isLatest || observed.fill == null) return { suggested: lastUsed, feedback: null };

	const enough = observed.fill >= FILL_ENOUGH;
	const amount = observed.amount ?? null;
	// Senza la quantità registrata (le irrigazioni di prima) il riscontro si mostra,
	// ma non si sa di quanto aumentare: "di più" rispetto a cosa?
	const suggested = amount == null ? lastUsed : enough ? amount : stepUp(amount);
	return { suggested, feedback: { amount, fill: observed.fill, enough } };
}
