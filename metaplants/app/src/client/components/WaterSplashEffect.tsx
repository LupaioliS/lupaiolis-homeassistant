import { motion } from 'motion/react';

export interface SplashTarget {
	id: string;
	x: number;
	y: number;
}

export const DROPLET_FALL_DURATION_S = 0.85;
export const DROPLET_STAGGER_S = 0.15;
// Fraction of the fall duration at which the droplet first touches the target (before the small bounce-settle).
export const DROPLET_ARRIVAL_FRACTION = 0.6;

interface WaterSplashEffectProps {
	targets: SplashTarget[];
	onSettle: (id: string) => void;
}

export function WaterSplashEffect({ targets, onSettle }: WaterSplashEffectProps) {
	if (targets.length === 0) return null;

	return (
		<div className="water-splash-overlay">
			{targets.map((target, i) => {
				const delay = i * DROPLET_STAGGER_S;
				return (
					<div key={target.id} className="water-droplet-anchor" style={{ left: target.x, top: target.y }}>
						<motion.span
							className="water-droplet"
							initial={{ y: -90, opacity: 0, scale: 0.5, rotate: -20 }}
							animate={{ y: [-90, 0, -12, 0], opacity: [0, 1, 1, 1], scale: [0.5, 1.25, 0.88, 1], rotate: [-20, 8, -4, 0] }}
							transition={{ duration: DROPLET_FALL_DURATION_S, delay, times: [0, DROPLET_ARRIVAL_FRACTION, 0.82, 1], ease: 'easeOut' }}
							onAnimationComplete={() => onSettle(target.id)}
						>
							💧
						</motion.span>
						<motion.span
							className="water-ripple"
							initial={{ scale: 0, opacity: 0 }}
							animate={{ scale: [0, 1.8], opacity: [0.55, 0] }}
							transition={{ duration: 0.55, delay: delay + DROPLET_ARRIVAL_FRACTION * DROPLET_FALL_DURATION_S, ease: 'easeOut' }}
						/>
					</div>
				);
			})}
		</div>
	);
}
