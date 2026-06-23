import { useState } from 'react';
import type { Plant } from '../../shared/types';
import { t } from '../i18n';

export type ActionDialogType = 'water' | 'fertilize' | 'repot';

interface ActionDialogProps {
	type: ActionDialogType;
	plant: Plant;
	defaultValue?: number;
	onConfirm: (value: number) => void | Promise<void>;
	onClose: () => void;
}

const WATER_MAX_ML = 1000;
const WATER_DEFAULT_ML = 200;
const FERTILIZE_MAX_G = 50;
const FERTILIZE_DEFAULT_G = 5;
const POT_MIN_CM = 5;
const POT_MAX_CM = 60;
const POT_MIN_SCALE = 0.55;
const POT_MAX_SCALE = 1.5;

export function ActionDialog({ type, plant, defaultValue, onConfirm, onClose }: ActionDialogProps) {
	const fallback =
		type === 'water' ? WATER_DEFAULT_ML
		: type === 'fertilize' ? FERTILIZE_DEFAULT_G
		: Math.min(POT_MAX_CM, plant.potSizeCm ?? 12);
	const [value, setValue] = useState(defaultValue ?? fallback);
	const [submitting, setSubmitting] = useState(false);

	const handleConfirm = async () => {
		setSubmitting(true);
		try {
			await onConfirm(value);
		} finally {
			setSubmitting(false);
		}
	};

	const title =
		type === 'water' ? t('actions.waterTitle')
		: type === 'fertilize' ? t('actions.fertilizeTitle')
		: t('actions.repotTitle');

	const verticalRangeProps = { orient: 'vertical' } as React.InputHTMLAttributes<HTMLInputElement>;

	const potScale = POT_MIN_SCALE + ((value - POT_MIN_CM) / (POT_MAX_CM - POT_MIN_CM)) * (POT_MAX_SCALE - POT_MIN_SCALE);

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal action-dialog" onClick={(e) => e.stopPropagation()}>
				<h2>{title}</h2>

				{type === 'water' && (
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
