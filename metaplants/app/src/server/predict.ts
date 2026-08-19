import type { Plant, PlantAction, CalibrationObservation, SoilCalibration, WateringPrediction, PredictionConfidence } from '../shared/types';
import { DAY_MS, HOUR_MS, getSeasonForDate, getCurrentSeason } from '../shared/schedule';
import { getSamples, type Sample } from './history';
import { findRises, samplePeak, sampleTrough } from '../shared/soil';

/**
 * Stima "fatta in casa" di quando la pianta andrà innaffiata.
 *
 * Nessuna libreria, nessun modello addestrato: due regressioni lineari e qualche
 * mediana su dati che l'add-on già raccoglie. Gira su ogni poll e costa qualche
 * centinaio di operazioni per pianta.
 *
 * Impara due cose:
 *  1. la CALIBRAZIONE della scala del sensore — se innaffi sistematicamente al 30%,
 *     allora per questa pianta il 30% grezzo è terra asciutta, cioè lo 0% utile.
 *     È questa scala, non la lettura grezza, a far scattare l'allerta (shared/soil.ts),
 *     e si muove SOLO sulle irrigazioni registrate: pulsante "acqua" o conferma del
 *     prompt "hai innaffiato?". Niente azione, niente ritaratura;
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
// L'azione può essere registrata parecchio dopo l'irrigazione vera: il prompt "hai
// innaffiato?" arriva al poll successivo e la conferma può arrivare a fine giornata.
// Dentro questa finestra prima di w si cerca la risalita, cioè il momento in cui
// l'acqua è arrivata davvero; l'orario del pulsante serve solo a trovare la finestra.
const ACTION_LAG_MS = 12 * HOUR_MS;
// Sotto questa escursione fra asciutto e bagnato la calibrazione non è credibile.
const MIN_CALIBRATION_SPAN = 5;
// Quanti campioni, e su che arco, servono PRIMA della risalita perché il punto secco
// di quel ciclo valga qualcosa. Con meno di così la finestra contiene solo letture
// già bagnate e il "secco" appreso sarebbe l'irrigazione stessa.
const MIN_DRY_SAMPLES = 2;
const MIN_DRY_SPAN_MS = 30 * 60 * 1000;
// Quante irrigazioni recenti descrivono la scala ATTUALE del sensore. Oltre questa
// finestra i picchi vecchi tengono in vita una taratura che il sensore non regge più:
// i capacitivi derivano, e un massimo di due settimane fa non dice più a quanto arriva
// il terreno bagnato oggi.
const CALIBRATION_CYCLES = 3;
// Quanti cicli consecutivi devono restare sotto il riferimento perché il tetto scenda.
const WET_DROP_CONFIRMATIONS = 2;
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

/** Percentile con interpolazione lineare; con un solo valore restituisce quello. */
function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 1) return sorted[0];
	const position = (sorted.length - 1) * p;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
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

interface CycleObservation {
	/** Istante dell'irrigazione confermata da cui arriva l'osservazione. */
	at: number;
	/** Minimo prima dell'acqua: il livello a cui questa pianta viene innaffiata. */
	dry: number | null;
	/** Massimo attorno all'irrigazione: il livello del terreno pieno. */
	wet: number | null;
}

/**
 * Cosa ha visto il sensore attorno ad ogni irrigazione, in ordine cronologico.
 *
 * `waterings` contiene solo azioni `water` registrate davvero: pulsante "acqua"
 * (app, MQTT o registrazione manuale) oppure conferma del prompt "hai innaffiato?".
 * Un salto rilevato e non confermato non arriva fin qui, ed è voluto: la taratura
 * si muove solo quando sai per certo che c'è stata acqua.
 */
function observeCycles(soil: Sample[], waterings: number[], riseDelta?: number): CycleObservation[] {
	const observations: CycleObservation[] = [];
	for (const w of waterings) {
		// L'istante registrato non coincide con l'irrigazione vera: col prompt "hai
		// innaffiato?" l'azione viene salvata quando il sensore è GIÀ salito, e la
		// conferma può arrivare ore dopo. Perciò si guarda dentro una finestra ampia
		// attorno a w invece di fidarsi dell'orario esatto.
		const around = soil.filter((s) => s.t >= w - ACTION_LAG_MS && s.t <= w + WET_PEAK_WINDOW_MS);
		if (around.length === 0) continue;

		// Dentro la finestra si cerca DOVE è arrivata l'acqua, cioè la risalita nella
		// curva: è l'unico riferimento che non dipende da quando hai premuto il
		// pulsante. Il secco sta prima di quel punto, il bagnato da lì in poi.
		const rise = findRises(around, riseDelta)[0];
		const beforeRise = rise != null ? around.slice(0, rise) : around.filter((s) => s.t <= w);
		const fromRise = rise != null ? around.slice(rise) : around;

		// Senza abbastanza dati PRIMA della risalita non si sa a che percentuale fosse
		// il terreno: le letture rimaste sono già bagnate. Meglio nessuna osservazione
		// che insegnare un punto secco preso dallo schizzo dell'irrigazione stessa —
		// era esattamente così che una pianta innaffiata al 38% imparava "secco = 53%".
		const spanMs = beforeRise.length > 1 ? beforeRise[beforeRise.length - 1].t - beforeRise[0].t : 0;
		const dryUsable = beforeRise.length >= MIN_DRY_SAMPLES && spanMs >= MIN_DRY_SPAN_MS;

		observations.push({
			at: w,
			dry: dryUsable ? Math.min(...beforeRise.map(sampleTrough)) : null,
			wet: Math.max(...fromRise.map(samplePeak)),
		});
	}
	return observations;
}

/**
 * Il livello del terreno "pieno", cioè il 100% della scala.
 *
 * "Pieno" è per natura un estremo, non una media: una bagnata abbondante conta più
 * di un rabbocco, quindi il riferimento è il 75° percentile dei cicli recenti. Il
 * tetto scende solo dopo WET_DROP_CONFIRMATIONS cicli consecutivi sotto il
 * riferimento: una singola innaffiata avara non deve schiacciare la scala, un
 * sensore che deriva verso il basso invece sì, e si distingue proprio perché insiste.
 *
 * Fino alla 1.10.2 il tetto si alzava anche da solo, appena il ciclo in corso
 * leggeva più in alto, per recuperare le irrigazioni mai confermate. Non lo fa più:
 * ora la scala IA è ciò che fa scattare l'allerta, quindi deve muoversi solo su
 * eventi certi — pulsante "acqua" o conferma del prompt. Un picco raccolto dal
 * ciclo aperto (o dalla deriva del sensore verso l'alto) altrimenti sposterebbe
 * l'allerta senza che nessuno abbia mai detto che c'è stata acqua.
 */
function resolveWetPoint(wetValues: number[]): number {
	const baseline = percentile(wetValues, 0.75);
	const tail = wetValues.slice(-WET_DROP_CONFIRMATIONS);
	const drifting = tail.length === WET_DROP_CONFIRMATIONS && tail.every((v) => v < baseline);
	return drifting ? Math.max(...tail) : baseline;
}

/**
 * Ricava la scala reale del sensore: a che % innaffi (0% utile) e a che %
 * arriva il terreno appena bagnato (100%).
 */
function calibrate(soil: Sample[], waterings: number[], fallbackDry?: number, riseDelta?: number): SoilCalibration | null {
	// Solo le ultime irrigazioni osservate: la scala deve descrivere il sensore com'è
	// adesso, non la media di com'era nelle ultime due settimane.
	const recent = observeCycles(soil, waterings, riseDelta).slice(-CALIBRATION_CYCLES);
	const dryValues = recent.map((o) => o.dry).filter((v): v is number => v != null);
	const wetValues = recent.map((o) => o.wet).filter((v): v is number => v != null);
	// Esposte così com'è: il punto secco è la mediana dei minimi, quindi un ciclo
	// con una lettura sballata sposta la scala senza comparire da nessuna parte.
	const observations: CalibrationObservation[] = recent.map((o) => ({
		at: new Date(o.at).toISOString(),
		dry: o.dry == null ? null : round(o.dry),
		wet: o.wet == null ? null : round(o.wet),
	}));

	if (dryValues.length === 0 || wetValues.length === 0) {
		// Nessuna irrigazione confermata che il sensore abbia visto: si ripiega sulla
		// soglia impostata a mano, che diventa lo 0% della scala. Con samples: 0 chi
		// legge sa che è un innesco provvisorio, non qualcosa di imparato: la % IA qui
		// scatta esattamente dove scattava la soglia grezza, finché non arriva la prima
		// irrigazione registrata.
		if (fallbackDry == null || soil.length === 0) return null;
		const observedPeak = Math.max(...soil.map(samplePeak));
		if (observedPeak - fallbackDry < MIN_CALIBRATION_SPAN) return null;
		return { dryPoint: round(fallbackDry), wetPoint: round(observedPeak), samples: 0, lastCalibratedAt: null, observations };
	}

	const dryPoint = median(dryValues);
	const wetPoint = resolveWetPoint(wetValues);

	if (wetPoint - dryPoint < MIN_CALIBRATION_SPAN) return null;

	return {
		dryPoint: round(dryPoint),
		wetPoint: round(wetPoint),
		samples: recent.length,
		lastCalibratedAt: new Date(recent[recent.length - 1].at).toISOString(),
		observations,
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

	const calibration = calibrate(soil, waterings, plant.sensors?.soilHumidityThreshold, plant.sensors?.soilJumpDelta);
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
