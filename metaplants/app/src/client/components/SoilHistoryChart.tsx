import { useEffect, useMemo, useState } from 'react';
import type { SensorSample, SoilCalibration, WaterSource } from '../../shared/types';
import { t } from '../i18n';
import { api } from '../api';
import { buildSoilChart, peakOf, type WateringMark } from '../soilChart';

/**
 * La curva dell'umidità del terreno, con sopra ciò che l'add-on ne ha dedotto.
 *
 * Fino alla 1.10.3 lo storico esisteva solo lato server: la scheda mostrava due
 * numeri (0% = tot, 100% = tot) e non c'era modo di sapere da dove venissero. Un
 * buco del sensore e una conca vera producono lo stesso numero, ma sul grafico
 * sono inconfondibili — uno è uno spillo, l'altra dura ore.
 *
 * Perciò qui si disegnano insieme: la lettura grezza, i due punti della scala
 * appresa, le irrigazioni registrate e le risalite che nessuno ha confermato.
 */

const RANGES = [3, 7, 14] as const;

const W = 620;
const H = 170;
const PAD_L = 30;
const PAD_R = 12;
const PAD_T = 14;
const PAD_B = 22;
const BOX = { width: W, height: H, padLeft: PAD_L, padRight: PAD_R, padTop: PAD_T, padBottom: PAD_B };

const COLOR_LINE = '#334155';
const COLOR_AREA = 'rgba(51, 65, 85, 0.08)';
const COLOR_DRY = '#b45309';
const COLOR_WET = '#2563eb';
const COLOR_MUTED = '#9ca3af';

// Stessi simboli del selettore nel dialog dell'acqua: la legenda è nel gesto che hai fatto.
const SOURCE_EMOJI: Record<WaterSource, string> = { manual: '💧', rain: '🌧️', irrigation: '🚿' };

interface SoilHistoryChartProps {
	plantId: string;
	/** Irrigazioni registrate: il marker cambia con chi ha dato l'acqua. */
	waterings: WateringMark[];
	calibration?: SoilCalibration | null;
	/** Soglia manuale: disegnata solo finché non c'è una scala appresa. */
	threshold?: number;
	jumpDelta?: number;
}

export function SoilHistoryChart({ plantId, waterings, calibration, threshold, jumpDelta }: SoilHistoryChartProps) {
	const [samples, setSamples] = useState<SensorSample[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [days, setDays] = useState<number>(7);

	// Si scarica una volta sola l'arco massimo, poi cambiare intervallo è solo un
	// ritaglio: il pulsante 3g/7g/14g non deve costare una richiesta.
	useEffect(() => {
		let cancelled = false;
		setSamples(null);
		setFailed(false);
		api.getHistory(plantId, RANGES[RANGES.length - 1])
			.then((res) => { if (!cancelled) setSamples(res.samples); })
			.catch(() => { if (!cancelled) setFailed(true); });
		return () => { cancelled = true; };
	}, [plantId]);

	const chart = useMemo(
		() => (samples ? buildSoilChart({
			samples,
			waterings,
			days,
			box: BOX,
			calibration,
			threshold,
			jumpDelta,
		}) : null),
		[samples, days, calibration, threshold, jumpDelta, waterings],
	);

	return (
		<div className="soil-chart">
			<div className="soil-chart-head">
				<span className="soil-chart-title">{t('chart.title')}</span>
				<div className="soil-chart-ranges">
					{RANGES.map((r) => (
						<button
							key={r}
							type="button"
							className={`soil-chart-range ${r === days ? 'active' : ''}`}
							onClick={() => setDays(r)}
						>
							{t('chart.days').replace('{days}', String(r))}
						</button>
					))}
				</div>
			</div>

			{failed && <p className="soil-chart-note">{t('chart.error')}</p>}
			{!failed && samples === null && <p className="soil-chart-note">{t('chart.loading')}</p>}
			{!failed && samples !== null && chart === null && <p className="soil-chart-note">{t('chart.empty')}</p>}

			{chart && (
				<>
					<svg className="soil-chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('chart.title')}>
						{/* Griglia orizzontale: tre riferimenti bastano a leggere l'altezza */}
						{[chart.minY, (chart.minY + chart.maxY) / 2, chart.maxY].map((v) => (
							<g key={v}>
								<line x1={PAD_L} x2={W - PAD_R} y1={chart.y(v)} y2={chart.y(v)} stroke="#e5e7eb" strokeWidth="1" />
								<text x={PAD_L - 4} y={chart.y(v)} textAnchor="end" dominantBaseline="middle" fontSize="9" fill="#9ca3af">
									{Math.round(v)}
								</text>
							</g>
						))}

						{chart.ticks.map((ts) => (
							<text key={ts} x={chart.x(ts)} y={H - 6} textAnchor="middle" fontSize="9" fill="#9ca3af">
								{new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'numeric' })}
							</text>
						))}

						{/* Irrigazioni registrate: sono i momenti su cui la scala si ritara.
						    L'emoji dice chi ha dato l'acqua, così un ciclo strano si spiega
						    subito ("ah, quella era pioggia"). */}
						{chart.waterings.map((w) => (
							<g key={`w-${w.t}`}>
								<line x1={chart.x(w.t)} x2={chart.x(w.t)} y1={PAD_T} y2={H - PAD_B} stroke={COLOR_WET} strokeWidth="1" opacity="0.35" />
								<text x={chart.x(w.t)} y={PAD_T - 3} textAnchor="middle" fontSize="9">
									{SOURCE_EMOJI[w.source ?? 'manual']}
									<title>
										{`${t(`actions.source_${w.source ?? 'manual'}`)} — ${new Date(w.t).toLocaleString()}`}
									</title>
								</text>
							</g>
						))}

						{/* Risalite mai confermate: acqua che il modello non ha potuto usare */}
						{chart.unconfirmed.map((j) => (
							<g key={`j-${j}`}>
								<line x1={chart.x(j)} x2={chart.x(j)} y1={PAD_T} y2={H - PAD_B} stroke={COLOR_MUTED} strokeWidth="1" strokeDasharray="2 3" />
								<text x={chart.x(j)} y={PAD_T - 3} textAnchor="middle" fontSize="9" fill={COLOR_MUTED}>
									?
									<title>{`${t('chart.unconfirmed')} — ${new Date(j).toLocaleString()}`}</title>
								</text>
							</g>
						))}

						{chart.areas.map((d, i) => <path key={i} d={d} fill={COLOR_AREA} />)}
						<path d={chart.line} fill="none" stroke={COLOR_LINE} strokeWidth="1.6" strokeLinejoin="round" />

						{/* Picchi brevi dentro un bucket: è da questi che esce il punto "pieno" */}
						{chart.peaks.map((s) => (
							<line
								key={`p-${s.t}`}
								x1={chart.x(s.t)} x2={chart.x(s.t)}
								y1={chart.y(s.v)} y2={chart.y(peakOf(s))}
								stroke={COLOR_LINE} strokeWidth="1" opacity="0.35"
							/>
						))}

						{/* Le due linee della scala appresa: qui il grafico spiega i due numeri */}
						{calibration && (
							<>
								<line x1={PAD_L} x2={W - PAD_R} y1={chart.y(calibration.dryPoint)} y2={chart.y(calibration.dryPoint)} stroke={COLOR_DRY} strokeWidth="1.2" strokeDasharray="5 4" />
								<text x={W - PAD_R} y={chart.y(calibration.dryPoint) - 3} textAnchor="end" fontSize="9" fill={COLOR_DRY}>
									{t('chart.dryLine')}
								</text>
								<line x1={PAD_L} x2={W - PAD_R} y1={chart.y(calibration.wetPoint)} y2={chart.y(calibration.wetPoint)} stroke={COLOR_WET} strokeWidth="1.2" strokeDasharray="5 4" />
								<text x={W - PAD_R} y={chart.y(calibration.wetPoint) + 9} textAnchor="end" fontSize="9" fill={COLOR_WET}>
									{t('chart.wetLine')}
								</text>
							</>
						)}
						{!calibration && threshold != null && (
							<>
								<line x1={PAD_L} x2={W - PAD_R} y1={chart.y(threshold)} y2={chart.y(threshold)} stroke={COLOR_DRY} strokeWidth="1.2" strokeDasharray="2 3" />
								<text x={W - PAD_R} y={chart.y(threshold) - 3} textAnchor="end" fontSize="9" fill={COLOR_DRY}>
									{t('chart.thresholdLine')}
								</text>
							</>
						)}
					</svg>
					<div className="soil-chart-legend">
						<span>{SOURCE_EMOJI.manual} {t('chart.watered')}</span>
						{chart.unconfirmed.length > 0 && <span>? {t('chart.unconfirmed')}</span>}
					</div>
				</>
			)}
		</div>
	);
}
