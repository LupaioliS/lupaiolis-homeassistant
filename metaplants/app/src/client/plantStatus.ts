import type { Season, SeasonalSchedule } from '../shared/types';

export function getIntervalForSeason(schedule: SeasonalSchedule | undefined, season: Season, fallbackDays: number): number {
	const seasonal = schedule?.[season];
	if (typeof seasonal === 'number' && seasonal > 0) return seasonal;
	return fallbackDays;
}

export function isOverdue(lastAction: string | undefined, intervalDays: number): boolean {
	if (!lastAction) return true;
	const elapsedMs = Date.now() - new Date(lastAction).getTime();
	return elapsedMs >= intervalDays * 24 * 60 * 60 * 1000;
}
