import type { Season, SeasonalSchedule } from './types';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export function getSeasonForDate(date: Date): Season {
	const month = date.getMonth();
	if (month >= 2 && month <= 4) return 'spring';
	if (month >= 5 && month <= 7) return 'summer';
	if (month >= 8 && month <= 10) return 'autumn';
	return 'winter';
}

export function getCurrentSeason(): Season {
	return getSeasonForDate(new Date());
}

export function getIntervalForSeason(
	schedule: SeasonalSchedule | undefined,
	season: Season,
	fallbackDays: number,
): number {
	const seasonal = schedule?.[season];
	if (typeof seasonal === 'number' && seasonal > 0) return seasonal;
	return fallbackDays;
}

function startOfDay(timestamp: number): number {
	const d = new Date(timestamp);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/**
 * Whole calendar days between two instants, ignoring the time of day.
 * Rounding absorbs the ±1h drift introduced by DST changes.
 */
export function calendarDaysBetween(from: number, to: number): number {
	return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
}

export interface DueInfo {
	/** Instant the action becomes due; null when the action was never performed. */
	dueAt: number | null;
	overdue: boolean;
	/** Time left before it becomes due (0 once overdue). */
	remainingMs: number;
	/**
	 * Calendar days left before the due date: 0 = due today, 1 = tomorrow.
	 * Deliberately NOT `ceil(remainingMs / DAY_MS)` — that rounds a due date
	 * of "tomorrow morning" up to "in 2 days" and makes the countdown look
	 * like it skips a day.
	 */
	remainingDays: number;
	/** Hours left, for the sub-day countdown. */
	remainingHours: number;
	/** How long ago it fell due (0 when not overdue). */
	overdueMs: number;
	overdueDays: number;
	overdueHours: number;
}

export function describeDue(
	lastAction: string | undefined,
	intervalDays: number,
	now: number = Date.now(),
): DueInfo {
	const empty: DueInfo = {
		dueAt: null,
		overdue: true,
		remainingMs: 0,
		remainingDays: 0,
		remainingHours: 0,
		overdueMs: 0,
		overdueDays: 0,
		overdueHours: 0,
	};
	if (!lastAction) return empty;

	const last = new Date(lastAction).getTime();
	if (Number.isNaN(last)) return empty;

	const dueAt = last + intervalDays * DAY_MS;
	if (now >= dueAt) {
		const overdueMs = now - dueAt;
		return {
			dueAt,
			overdue: true,
			remainingMs: 0,
			remainingDays: 0,
			remainingHours: 0,
			overdueMs,
			overdueDays: Math.floor(overdueMs / DAY_MS),
			overdueHours: Math.max(1, Math.floor(overdueMs / HOUR_MS)),
		};
	}

	const remainingMs = dueAt - now;
	return {
		dueAt,
		overdue: false,
		remainingMs,
		remainingDays: Math.max(0, calendarDaysBetween(now, dueAt)),
		remainingHours: Math.max(1, Math.ceil(remainingMs / HOUR_MS)),
		overdueMs: 0,
		overdueDays: 0,
		overdueHours: 0,
	};
}

export function isOverdue(lastAction: string | undefined, intervalDays: number, now?: number): boolean {
	return describeDue(lastAction, intervalDays, now).overdue;
}
