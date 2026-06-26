import { useMemo } from 'react';
import { motion } from 'motion/react';
import type { FillTarget } from './WaterFillOverlay';

export const SPROUT_DURATION_MS = 2900;

const SPROUT_EMOJIS = ['🌱', '🌿', '🌷', '🌸', '🌻', '🌼', '🌹'];

const SPROUT_SLOTS = [
	{ left: '6%', delay: 0.85, hold: 0.85 },
	{ left: '26%', delay: 1.0, hold: 0.8 },
	{ left: '48%', delay: 0.9, hold: 0.9 },
	{ left: '68%', delay: 1.05, hold: 0.8 },
	{ left: '88%', delay: 0.95, hold: 0.85 },
];

const CRUMBS = [
	{ left: '36%', delay: 0.15 },
	{ left: '50%', delay: 0.35 },
	{ left: '64%', delay: 0.55 },
	{ left: '44%', delay: 0.75 },
];

function pickSprouts() {
	return SPROUT_SLOTS.map((slot) => ({ ...slot, emoji: SPROUT_EMOJIS[Math.floor(Math.random() * SPROUT_EMOJIS.length)] }));
}

interface FertilizeSproutEffectProps {
	targets: FillTarget[];
}

export function FertilizeSproutEffect({ targets }: FertilizeSproutEffectProps) {
	const sproutsByTarget = useMemo(
		() => Object.fromEntries(targets.map((target) => [target.id, pickSprouts()])),
		[targets]
	);

	if (targets.length === 0) return null;

	return (
		<>
			{targets.map((target) => (
				<div
					key={target.id}
					className="fert-sprout-box"
					style={{ left: target.left, top: target.top, width: target.width, height: target.height, borderRadius: target.radius }}
				>
					<motion.span
						className="fert-bag"
						initial={{ opacity: 0, rotate: 0, y: -6 }}
						animate={{ opacity: [0, 1, 1, 1, 0], rotate: [0, -15, 35, 35, 20], y: [-6, -2, -2, -2, 2] }}
						transition={{ duration: 1.1, times: [0, 0.2, 0.45, 0.85, 1], ease: 'easeInOut' }}
					>
						🛍️
					</motion.span>

					{CRUMBS.map((crumb, i) => (
						<motion.span
							key={i}
							className="fert-crumb"
							style={{ left: crumb.left }}
							initial={{ y: -14, opacity: 0, rotate: 0 }}
							animate={{ y: 24, opacity: [0, 1, 1, 0], rotate: 160 }}
							transition={{ duration: 0.75, delay: crumb.delay, ease: 'easeIn' }}
						/>
					))}

					{sproutsByTarget[target.id]?.map((sprout, i) => (
						<motion.span
							key={i}
							className="fert-sprout"
							style={{ left: sprout.left }}
							initial={{ scale: 0, opacity: 0 }}
							animate={{ scale: [0, 1.15, 1, 1, 0], opacity: [0, 1, 1, 1, 0] }}
							transition={{
								duration: 0.45 + sprout.hold + 0.3,
								delay: sprout.delay,
								times: [0, 0.25, 0.4, 0.75, 1],
								ease: 'easeInOut',
							}}
						>
							{sprout.emoji}
						</motion.span>
					))}
				</div>
			))}
		</>
	);
}
