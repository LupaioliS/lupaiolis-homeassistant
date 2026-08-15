import type { Plant, PlantAction, SoilCalibration, WateringPrediction, PredictionConfidence } from '../shared/types';
import { DAY_MS, HOUR_MS, getSeasonForDate, getCurrentSeason } from '../shared/schedule';
import { getSamples, type Sample } from './history';

/**
 * Stima "fatta in casa" di quando la pianta andrà innaffiata.
 *
 * Nessuna libreria, nessun modello addestrato: due regressioni lineari e qualche
 * mediana su dati che l'add-on già raccoglie. Gira su ogni poll e costa qualche
 * centinaio di operazioni per pianta.
 *
 * Impara due cose:
 *  1. la CALIBRAZIONE della scala del sensore — se innaffi sistematicamente al 30%,
 *     allora per questa pianta il 30% grezzo è terra asciutta, cioè lo 0% utile;
 *  2. la VELOCITÀ di asciugatura in punti percentuali al giorno, da cui ricava
 *     quanto manca al livello a cui di solito innaffi.
 * Il ritmo storico fra un'irrigazione e l'altra fa da rete di sicurezza quando il
 * sensore non ha ancora abbastanza dati.
 */

// Finestra dopo l'irrigazione in cui il terreno è ancora saturo: i campioni qui
// dentro raccontano l'assorbimento, non l'asciugatura, e falserebbero la pendenza.
const SATURATION_MS = 2 * HOUR_MS;
// Entro questa finestra dopo l'irrigazione si cerca il picco = terreno "pieno".
const WET_PEAK_WINDOW_MS = 4 * HOUR_MS;
// Un campione più vecchio di così prima dell'irrigazione non descrive più il momento in cui hai innaffiato.
const DRY_LOOKBACK_MS = 3 * HOUR_MS;
// Sotto questa escursione fra asciutto e bagnato la calibrazione non è credibile.
const MIN_CALIBRATION_SPAN = 5;
// Servono almeno questi campioni, su questo arco di tempo, per fidarsi della pendenza.
const MIN_RATE_SAMPLES = 6;
const MIN_RATE_SPAN_MS = 6 * HOUR_MS;
// Cicli di irrigazione oltre i quali il modello si considera "maturo".
const CONFIDENT_CYCLES = 3;
const MAX_CYCLES_CONSIDERED = 8;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals = 1): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

/** Media oraria dei campioni: smorza il rumore del sensore prima della regressione. */
function bucketHourly(samples: Sample[]): Sample[] {
	const buckets = new Map<number, { sum: number; count: number; t: number }>();
	for (const s of samples) {
		const key = Math.floor(s.t / HOUR_MS);
		const entry = buckets.get(key);
		if (entry) {
			entry.sum += s.v;
			entry.count++;
		} else {
			buckets.set(key, { sum: s.v, count: 1, t: s.t });
		}
	}
	return [...buckets.values()]
		.map((b) => ({ t: b.t, v: b.sum / b.count }))
		.sort((a, b) => a.t - b.t);
}

interface Fit {
	/** Punti percentuali al giorno; negativo = si sta asciugando. */
	slopePerDay: number;
	r2: number;
	samples: number;
	spanMs: number;
}

function linearFit(samples: Sample[]): Fit | null {
	if (samples.length < 2) return null;
	const t0 = samples[0].t;
	const xs = samples.map((s) => (s.t - t0) / DAY_MS);
	const ys = samples.map((s) => s.v);
	const n = xs.length;
	const meanX = xs.reduce((a, b) => a + b, 0) / n;
	const meanY = ys.reduce((a, b) => a + b, 0) / n;

	let sxy = 0;
	let sxx = 0;
	for (let i = 0; i < n; i++) {
		sxy += (xs[i] - meanX) * (ys[i] - meanY);
		sxx += (xs[i] - meanX) ** 2;
	}
	if (sxx === 0) return null;

	const slopePerDay = sxy / sxx;
	const intercept = meanY - slopePerDay * meanX;

	let ssRes = 0;
	let ssTot = 0;
	for (let i = 0; i < n; i++) {
		ssRes += (ys[i] - (intercept + slopePerDay * xs[i])) ** 2;
		ssTot += (ys[i] - meanY) ** 2;
	}
	const r2 = ssTot === 0 ? 0 : clamp(1 - ssRes / ssTot, 0, 1);

	return { slopePerDay, r2, samples: n, spanMs: samples[n - 1].t - t0 };
}

function waterTimestamps(actions: PlantAction[]): number[] {
	return actions
		.filter((a) => a.type === 'water')
		.map((a) => new Date(a.date).getTime())
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => a - b);
}

/**
 * Ricava la scala reale del sensore: a che % innaffi (0% utile) e a che %
 * arriva il terreno appena bagnato (100%).
 */
function calibrate(soil: Sample[], waterings: number[], fallbackDry?: number): SoilCalibration | null {
	const dryCandidates: number[] = [];
	const wetCandidates: number[] = [];

	for (const w of waterings) {
		const before = soil.filter((s) => s.t <= w && s.t >= w - DRY_LOOKBACK_MS);
		if (before.length > 0) dryCandidates.push(before[before.length - 1].v);

		const after = soil.filter((s) => s.t > w && s.t <= w + WET_PEAK_WINDOW_MS);
		if (after.length > 0) wetCandidates.push(Math.max(...after.map((s) => s.v)));
	}

	if (dryCandidates.length === 0) {
		// Nessuna irrigazione osservata dal sensore: si ripiega sulla soglia impostata a mano.
		if (fallbackDry == null || soil.length === 0) return null;
		const observedPeak = Math.max(...soil.map((s) => s.v));
		if (observedPeak - fallbackDry < MIN_CALIBRATION_SPAN) return null;
		return { dryPoint: round(fallbackDry), wetPoint: round(observedPeak), samples: 0 };
	}

	const dryPoint = median(dryCandidates);
	const wetPoint = wetCandidates.length > 0
		? median(wetCandidates)
		: Math.max(...soil.map((s) => s.v));

	if (wetPoint - dryPoint < MIN_CALIBRATION_SPAN) return null;

	return {
		dryPoint: round(dryPoint),
		wetPoint: round(wetPoint),
		samples: Math.min(dryCandidates.length, Math.max(wetCandidates.length, dryCandidates.length)),
	};
}

/** Velocità di asciugatura del ciclo in corso; se non basta, media dei cicli passati. */
function estimateDryRate(soil: Sample[], waterings: number[]): { rate: number; r2: number } | null {
	const segments: Sample[][] = [];
	const lastWater = waterings[waterings.length - 1];

	if (lastWater != null) {
		segments.push(soil.filter((s) => s.t >= lastWater + SATURATION_MS));
		// Cicli chiusi, dal più recente: servono come ripiego quando quello in corso è appena iniziato.
		for (let i = waterings.length - 1; i >= 1 && segments.length <= MAX_CYCLES_CONSIDERED; i--) {
			const from = waterings[i - 1] + SATURATION_MS;
			const to = waterings[i];
			segments.push(soil.filter((s) => s.t >= from && s.t < to));
		}
	} else {
		segments.push(soil);
	}

	const fits: Fit[] = [];
	for (const segment of segments) {
		const fit = linearFit(bucketHourly(segment));
		if (!fit) continue;
		if (fit.slopePerDay >= 0) continue; // sta risalendo: non è asciugatura
		if (fit.samples < MIN_RATE_SAMPLES || fit.spanMs < MIN_RATE_SPAN_MS) continue;
		fits.push(fit);
	}
	if (fits.length === 0) return null;

	// Il ciclo in corso (primo segmento) è il più rappresentativo; gli altri lo stabilizzano.
	const current = fits[0];
	const rate = fits.length === 1 ? -current.slopePerDay : median(fits.map((f) => -f.slopePerDay));
	if (!(rate > 0)) return null;
	return { rate, r2: current.r2 };
}

/** Media dei giorni fra irrigazioni, preferendo quelle della stagione corrente. */
function averageCycle(waterings: number[]): { days: number; cycles: number } | null {
	if (waterings.length < 2) return null;
	const season = getCurrentSeason();
	const all: number[] = [];
	const seasonal: number[] = [];

	for (let i = 1; i < waterings.length; i++) {
		const deltaDays = (waterings[i] - waterings[i - 1]) / DAY_MS;
		if (deltaDays <= 0) continue;
		all.push(deltaDays);
		if (getSeasonForDate(new Date(waterings[i - 1])) === season) seasonal.push(deltaDays);
	}

	const source = seasonal.length >= 2 ? seasonal : all;
	if (source.length === 0) return null;
	const recent = source.slice(-MAX_CYCLES_CONSIDERED);
	const days = recent.reduce((a, b) => a + b, 0) / recent.length;
	return { days, cycles: all.length };
}

export function predictWatering(
	plant: Plant,
	actions: PlantAction[],
	currentSoil: number | null,
	now: number = Date.now(),
): WateringPrediction | null {
	const soil = getSamples(plant.id, 'soil');
	const waterings = waterTimestamps(actions);
	const cycleInfo = averageCycle(waterings);

	const calibration = calibrate(soil, waterings, plant.sensors?.soilHumidityThreshold);
	const dryRate = soil.length > 0 ? estimateDryRate(soil, waterings) : null;

	// Stima dal sensore: quanto manca a scendere fino al livello a cui innaffi.
	let sensorDays: number | null = null;
	if (dryRate && calibration && currentSoil != null) {
		sensorDays = Math.max(0, (currentSoil - calibration.dryPoint) / dryRate.rate);
	}

	// Stima dal ritmo: quanto manca alla scadenza media fra irrigazioni.
	let historyDays: number | null = null;
	if (cycleInfo && plant.lastWatered) {
		const since = (now - new Date(plant.lastWatered).getTime()) / DAY_MS;
		if (Number.isFinite(since)) historyDays = Math.max(0, cycleInfo.days - since);
	}

	if (sensorDays == null && historyDays == null) return null;

	let daysLeft: number;
	let source: WateringPrediction['source'];
	if (sensorDays != null && historyDays != null) {
		// Più il fit è pulito, più pesa la lettura reale rispetto alla media storica.
		const weight = clamp(dryRate!.r2, 0.3, 0.9);
		daysLeft = weight * sensorDays + (1 - weight) * historyDays;
		source = 'blend';
	} else if (sensorDays != null) {
		daysLeft = sensorDays;
		source = 'sensor';
	} else {
		daysLeft = historyDays!;
		source = 'history';
	}

	const cycles = cycleInfo?.cycles ?? 0;
	let confidence: PredictionConfidence = 'low';
	if (cycles >= CONFIDENT_CYCLES && dryRate != null && dryRate.r2 >= 0.7 && calibration != null && calibration.samples >= 2) {
		confidence = 'high';
	} else if ((cycles >= 2 && dryRate != null) || cycles >= CONFIDENT_CYCLES) {
		confidence = 'medium';
	}

	const normalized = calibration && currentSoil != null
		? clamp(((currentSoil - calibration.dryPoint) / (calibration.wetPoint - calibration.dryPoint)) * 100, 0, 100)
		: null;

	return {
		nextWateringAt: new Date(now + daysLeft * DAY_MS).toISOString(),
		daysLeft: round(daysLeft, 2),
		dryRatePerDay: dryRate ? round(dryRate.rate, 2) : null,
		calibration,
		normalizedSoilHumidity: normalized == null ? null : Math.round(normalized),
		averageCycleDays: cycleInfo ? round(cycleInfo.days, 1) : null,
		cycles,
		confidence,
		source,
	};
}
