import { motion } from 'motion/react';

export interface FillTarget {
	id: string;
	left: number;
	top: number;
	width: number;
	height: number;
	radius: string;
}

export const FILL_DURATION_MS = 1900;

const BUBBLES = [
	{ left: '22%', delay: 0.1, duration: 0.55 },
	{ left: '50%', delay: 0.35, duration: 0.5 },
	{ left: '76%', delay: 0.6, duration: 0.45 },
	{ left: '38%', delay: 0.85, duration: 0.5 },
	{ left: '64%', delay: 1.1, duration: 0.45 },
];

interface WaterFillOverlayProps {
	targets: FillTarget[];
}

export function WaterFillOverlay({ targets }: WaterFillOverlayProps) {
	if (targets.length === 0) return null;

	return (
		<>
			{targets.map((target) => (
				<div
					key={target.id}
					className="water-fill-box"
					style={{ left: target.left, top: target.top, width: target.width, height: target.height, borderRadius: target.radius }}
				>
					<motion.div
						className="water-fill-level"
						initial={{ height: '0%' }}
						animate={{ height: ['0%', '100%', '100%', '0%'] }}
						transition={{ duration: FILL_DURATION_MS / 1000, times: [0, 0.5, 0.88, 1], ease: 'easeInOut' }}
					>
						{BUBBLES.map((bubble, i) => (
							<motion.span
								key={i}
								className="water-fill-bubble"
								style={{ left: bubble.left }}
								initial={{ y: 0, opacity: 0 }}
								animate={{ y: -16, opacity: [0, 1, 0] }}
								transition={{ duration: bubble.duration, delay: bubble.delay, repeat: 2, repeatDelay: 0.1, ease: 'easeOut' }}
							/>
						))}
					</motion.div>
				</div>
			))}
		</>
	);
}
