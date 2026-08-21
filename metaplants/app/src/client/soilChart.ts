import type { SensorSample, SoilCalibration, WaterSource } from '../shared/types';
import { findRises, samplePeak } from '../shared/soil';

/** Un'irrigazione registrata, con chi ha dato l'acqua se lo sappiamo. */
export interface WateringMark {
	t: number;
	source?: WaterSource;
}

/**
 * La matematica del grafico dell'umidità, separata dal componente.
 *
 * Sta fuori dal .tsx per lo stesso motivo per cui ci sta `waterStatus.ts`: è logica
 * verificabile senza montare React, e le parti che possono davvero sbagliare (dove
 * si spezza la linea, quali risalite contano come non confermate) sono tutte qui.
 */

const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;

// Oltre questo buco fra due campioni la linea si spezza invece di attraversare ore
// di dati che non esistono: un sensore staccato deve VEDERSI come staccato.
const GAP_MS = 2 * HOUR_MS;
// Un'irrigazione viene registrata anche parecchio dopo il fatto (stessa finestra di
// predict.ts): un salto entro queste ore da un'azione non è "non confermato".
const JUMP_MATCH_MS = 12 * HOUR_MS;
// Dislivello minimo fra valore e picco del bucket perché valga la pena disegnarlo.
const PEAK_MARK_MIN = 3;

export const peakOf = samplePeak;

export interface ChartBox {
	width: number;
	height: number;
	padLeft: number;
	padRight: number;
	padTop: number;
	padBottom: number;
}

export interface ChartInput {
	samples: SensorSample[];
	/** Irrigazioni registrate, con la provenienza per scegliere il marker. */
	waterings: WateringMark[];
	days: number;
	box: ChartBox;
	calibration?: SoilCalibration | null;
	threshold?: number;
	jumpDelta?: number;
	now?: number;
}

export interface ChartGeometry {
	x: (t: number) => number;
	y: (v: number) => number;
	minY: number;
	maxY: number;
	/** Path della curva, con un "M" ad ogni interruzione. */
	line: string;
	/** Aree sotto la curva, una per segmento continuo. */
	areas: string[];
	/** Inizi di giornata da etichettare sull'asse x. */
	ticks: number[];
	/** Campioni il cui picco dentro il bucket merita un trattino verticale. */
	peaks: SensorSample[];
	/** Irrigazioni registrate che cadono nell'intervallo mostrato. */
	waterings: WateringMark[];
	/** Risalite marcate senza un'irrigazione registrata attorno. */
	unconfirmed: number[];
}

export function buildSoilChart(input: ChartInput): ChartGeometry | null {
	const { samples, waterings, days, box, calibration, threshold, jumpDelta } = input;
	if (samples.length === 0) return null;

	const to = input.now ?? Date.now();
	const from = to - days * DAY_MS;
	const visible = samples.filter((s) => s.t >= from);
	if (visible.length === 0) return null;

	// La scala verticale deve contenere anche le linee di riferimento, altrimenti il
	// punto "pieno" finisce fuori dal grafico proprio quando serve vederlo.
	const values = visible.flatMap((s) => [s.v, peakOf(s)]);
	if (calibration) values.push(calibration.dryPoint, calibration.wetPoint);
	else if (threshold != null) values.push(threshold);
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	const pad = Math.max(2, (hi - lo) * 0.1);
	const minY = Math.max(0, lo - pad);
	const maxY = hi > 100 ? hi + pad : Math.min(100, hi + pad);
	const span = maxY - minY || 1;

	const x = (ts: number) => box.padLeft + ((ts - from) / (to - from)) * (box.width - box.padLeft - box.padRight);
	const y = (v: number) => box.padTop + (1 - (v - minY) / span) * (box.height - box.padTop - box.padBottom);

	// Segmenti separati dai buchi: ognuno diventa una linea e un'area a sé.
	const segments: SensorSample[][] = [];
	for (const s of visible) {
		const current = segments[segments.length - 1];
		if (!current || s.t - current[current.length - 1].t > GAP_MS) segments.push([s]);
		else current.push(s);
	}

	const path = (seg: SensorSample[]) =>
		seg.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`).join('');
	const base = (box.height - box.padBottom).toFixed(1);

	const line = segments.map(path).join(' ');
	const areas = segments
		.filter((seg) => seg.length > 1)
		.map((seg) => `${path(seg)}L${x(seg[seg.length - 1].t).toFixed(1)},${base}L${x(seg[0].t).toFixed(1)},${base}Z`);

	// Risalite: stessa identica regola del server (shared/soil.ts), non una copia —
	// i marker "?" devono essere esattamente i salti per cui l'add-on avrebbe chiesto
	// conferma, e su cui la calibrazione si ancora.
	const jumps = findRises(visible, jumpDelta).map((i) => visible[i].t);

	const dayStart = new Date(from);
	dayStart.setHours(0, 0, 0, 0);
	const tickStep = days <= 3 ? 1 : days <= 7 ? 2 : 3;
	const ticks: number[] = [];
	for (let d = dayStart.getTime() + DAY_MS; d <= to; d += DAY_MS * tickStep) ticks.push(d);

	return {
		x, y, minY, maxY, line, areas, ticks,
		peaks: visible.filter((s) => peakOf(s) - s.v >= PEAK_MARK_MIN),
		waterings: waterings.filter((w) => w.t >= from && w.t <= to),
		unconfirmed: jumps.filter((j) => !waterings.some((w) => Math.abs(w.t - j) <= JUMP_MATCH_MS)),
	};
}
