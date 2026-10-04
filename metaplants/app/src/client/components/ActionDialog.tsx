import { useState } from 'react';
import type { Plant, WaterAmount, WaterSource } from '../../shared/types';
import { t } from '../i18n';
import { WATER_AMOUNTS, WATER_AMOUNT_EMOJI } from '../waterAmount';

export type ActionDialogType = 'water' | 'fertilize' | 'repot';

export interface ActionDialogResult {
	/** Grammi di concime o diametro del vaso; assente per l'acqua. */
	value?: number;
	/** Solo acqua. Assente per la pioggia: quanta ne sia arrivata nel vaso non si sa. */
	amount?: WaterAmount;
	source?: WaterSource;
}

interface ActionDialogProps {
	type: ActionDialogType;
	plant: Plant;
	defaultValue?: number;
	/** Quantità d'acqua proposta: l'ultima usata, o quella che il sensore consiglia. */
	defaultAmount?: WaterAmount;
	/** Perché è proposta proprio quella, quando lo dice il sensore. */
	amountHint?: string | null;
	titleOverride?: string;
	subtitle?: string;
	onConfirm: (result: ActionDialogResult) => void | Promise<void>;
	onClose: () => void;
}

// L'ordine è quello in cui capitano: quasi sempre la innaffi tu.
const WATER_SOURCES: { id: WaterSource; emoji: string }[] = [
	{ id: 'manual', emoji: '💧' },
	{ id: 'rain', emoji: '🌧️' },
	{ id: 'irrigation', emoji: '🚿' },
];

const FERTILIZE_MAX_G = 50;
const FERTILIZE_DEFAULT_G = 5;
const POT_MIN_CM = 5;
const POT_MAX_CM = 60;
const POT_MIN_SCALE = 0.55;
const POT_MAX_SCALE = 1.5;

export function ActionDialog({ type, plant, defaultValue, defaultAmount, amountHint, titleOverride, subtitle, onConfirm, onClose }: ActionDialogProps) {
	const fallback = type === 'fertilize' ? FERTILIZE_DEFAULT_G : Math.min(POT_MAX_CM, plant.potSizeCm ?? 12);
	const [value, setValue] = useState(defaultValue ?? fallback);
	const [amount, setAmount] = useState<WaterAmount>(defaultAmount ?? 'normal');
	const [source, setSource] = useState<WaterSource>('manual');
	const [submitting, setSubmitting] = useState(false);

	// Della pioggia non si sa quanta ne sia arrivata nel vaso: meglio nessun dato
	// che uno inventato, visto che le quantità alimentano i suggerimenti.
	const amountKnown = type !== 'water' || source !== 'rain';

	const handleConfirm = async () => {
		setSubmitting(true);
		try {
			await onConfirm(
				type === 'water'
					? { amount: amountKnown ? amount : undefined, source }
					: { value },
			);
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
					<>
						<div className="source-picker amount-picker">
							{WATER_AMOUNTS.map((level) => (
								<button
									key={level}
									type="button"
									className={`source-option ${amount === level ? 'active' : ''}`}
									onClick={() => setAmount(level)}
									aria-pressed={amount === level}
								>
									<span className="source-emoji">{WATER_AMOUNT_EMOJI[level]}</span>
									<span>{t(`amount.${level}`)}</span>
								</button>
							))}
						</div>
						{amountHint && <p className="source-note">{amountHint}</p>}
					</>
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
