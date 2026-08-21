import { useState } from 'react';
import type { Plant, WaterSource } from '../../shared/types';
import { t } from '../i18n';

export type ActionDialogType = 'water' | 'fertilize' | 'repot';

interface ActionDialogProps {
	type: ActionDialogType;
	plant: Plant;
	defaultValue?: number;
	titleOverride?: string;
	subtitle?: string;
	/** Per l'acqua `value` può essere assente: della pioggia non si sanno i ml. */
	onConfirm: (value: number | undefined, source?: WaterSource) => void | Promise<void>;
	onClose: () => void;
}

// L'ordine è quello in cui capitano: quasi sempre la innaffi tu.
const WATER_SOURCES: { id: WaterSource; emoji: string }[] = [
	{ id: 'manual', emoji: '💧' },
	{ id: 'rain', emoji: '🌧️' },
	{ id: 'irrigation', emoji: '🚿' },
];

const WATER_MAX_ML = 1000;
const WATER_DEFAULT_ML = 200;
const FERTILIZE_MAX_G = 50;
const FERTILIZE_DEFAULT_G = 5;
const POT_MIN_CM = 5;
const POT_MAX_CM = 60;
const POT_MIN_SCALE = 0.55;
const POT_MAX_SCALE = 1.5;

export function ActionDialog({ type, plant, defaultValue, titleOverride, subtitle, onConfirm, onClose }: ActionDialogProps) {
	const fallback =
		type === 'water' ? WATER_DEFAULT_ML
		: type === 'fertilize' ? FERTILIZE_DEFAULT_G
		: Math.min(POT_MAX_CM, plant.potSizeCm ?? 12);
	const [value, setValue] = useState(defaultValue ?? fallback);
	const [source, setSource] = useState<WaterSource>('manual');
	const [submitting, setSubmitting] = useState(false);

	// Della pioggia non si sa quanta ne sia arrivata nel vaso: meglio nessun dato
	// che un numero inventato, visto che le quantità alimentano i suggerimenti.
	const amountKnown = type !== 'water' || source !== 'rain';

	const handleConfirm = async () => {
		setSubmitting(true);
		try {
			await onConfirm(amountKnown ? value : undefined, type === 'water' ? source : undefined);
		} finally {
			setSubmitting(false);
		}
	};

	const title = titleOverride ?? (
		type === 'water' ? t('actions.waterTitle')
		: type === 'fertilize' ? t('actions.fertilizeTitle')
		: t('actions.repotTitle')
	);

	const verticalRangeProps = { orient: 'vertical' } as React.InputHTMLAttributes<HTMLInputElement>;

	const potScale = POT_MIN_SCALE + ((value - POT_MIN_CM) / (POT_MAX_CM - POT_MIN_CM)) * (POT_MAX_SCALE - POT_MIN_SCALE);

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal action-dialog" onClick={(e) => e.stopPropagation()}>
				<h2>{title}</h2>
				{subtitle && <p className="action-dialog-subtitle">{subtitle}</p>}

				{type === 'water' && (
					<div className="source-picker">
						{WATER_SOURCES.map(({ id, emoji }) => (
							<button
								key={id}
								type="button"
								className={`source-option ${source === id ? 'active' : ''}`}
								onClick={() => setSource(id)}
								aria-pressed={source === id}
							>
								<span className="source-emoji">{emoji}</span>
								<span>{t(`actions.source_${id}`)}</span>
							</button>
						))}
					</div>
				)}

				{type === 'water' && !amountKnown && (
					<p className="source-note">{t('actions.rainAmountUnknown')}</p>
				)}

				{type === 'water' && amountKnown && (
					<div className="droplet-slider-wrap">
						<div className="droplet-slider">
							<div className="droplet-fill" style={{ height: `${(value / WATER_MAX_ML) * 100}%` }} />
							<input
								{...verticalRangeProps}
								type="range"
								className="droplet-input"
								min={0}
								max={WATER_MAX_ML}
								step={10}
								value={value}
								onChange={(e) => setValue(Number(e.target.value))}
							/>
						</div>
						<div className="slider-value">{value} ml</div>
						<small className="droplet-max-hint">
							{t('actions.waterMax')} ({WATER_MAX_ML} ml)
						</small>
					</div>
				)}

				{type === 'fertilize' && (
					<div className="droplet-slider-wrap">
						<div className="bag-slider">
							<div className="bag-fill" style={{ height: `${(value / FERTILIZE_MAX_G) * 100}%` }} />
							<div className="bag-knot" />
							<input
								{...verticalRangeProps}
								type="range"
								className="droplet-input"
								min={0}
								max={FERTILIZE_MAX_G}
								step={1}
								value={value}
								onChange={(e) => setValue(Number(e.target.value))}
							/>
						</div>
						<div className="slider-value">{value} g</div>
					</div>
				)}

				{type === 'repot' && (
					<div className="pot-slider-wrap">
						<div className="pot-visual" style={{ transform: `scale(${potScale})` }}>
							<div className="pot-rim" />
							<div className="pot-body" />
						</div>
						<input
							type="range"
							min={POT_MIN_CM}
							max={POT_MAX_CM}
							step={1}
							value={value}
							onChange={(e) => setValue(Number(e.target.value))}
						/>
						<div className="slider-value">{value} cm</div>
					</div>
				)}

				<div className="form-actions">
					<button type="button" className="btn btn-secondary" onClick={onClose}>{t('plant.cancel')}</button>
					<button type="button" className="btn btn-primary" onClick={handleConfirm} disabled={submitting}>
						{t('actions.confirm')}
					</button>
				</div>
			</div>
		</div>
	);
}
