import type { Plant, Season, SeasonalSchedule, SoilFeel } from './types';

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

/**
 * Di quanto la prova del dito rimanda il prossimo controllo, in proporzione alla
 * frequenza: un basilico ogni 2 giorni "umido" va ricontrollato domani, una
 * Zamioculcas ogni 14 fra 4. Bagnato rimanda il doppio di umido.
 */
const CHECK_POSTPONE: Record<SoilFeel, number> = { moist: 0.25, wet: 0.5 };

export function checkPostponeDays(intervalDays: number, soil: SoilFeel): number {
	return Math.max(1, Math.round(intervalDays * CHECK_POSTPONE[soil]));
}

export interface WaterDue extends DueInfo {
	/** Presente quando la scadenza viene da una prova del dito, non dall'irrigazione. */
	check: Plant['lastSoilCheck'] | null;
}

/**
 * Scadenza dell'acqua secondo il calendario: dall'ultima irrigazione, oppure
 * dall'ultima prova del dito che ha trovato il terreno ancora umido, se è venuta
 * dopo. Unico calcolo per scheda, banner e MQTT.
 */
export function describeWaterDue(
	plant: Pick<Plant, 'lastWatered' | 'lastSoilCheck'>,
	intervalDays: number,
	now: number = Date.now(),
): WaterDue {
	const check = plant.lastSoilCheck;
	const checkAt = check ? new Date(check.date).getTime() : NaN;
	const wateredAt = plant.lastWatered ? new Date(plant.lastWatered).getTime() : -Infinity;
	if (check && Number.isFinite(checkAt) && checkAt > wateredAt) {
		return { ...describeDue(check.date, checkPostponeDays(intervalDays, check.soil), now), check };
	}
	return { ...describeDue(plant.lastWatered, intervalDays, now), check: null };
}
