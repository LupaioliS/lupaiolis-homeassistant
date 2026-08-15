import type { PlantAction, Season, SeasonalSchedule } from '../shared/types';

// I confini fra le stagioni sono condivisi con il server (src/shared/schedule.ts).
export { getSeasonForDate, getCurrentSeason } from '../shared/schedule';
import { getSeasonForDate } from '../shared/schedule';

export const seasonEmoji: Record<Season, string> = {
	spring: '🌸',
	summer: '☀️',
	autumn: '🍂',
	winter: '❄️',
};

/**
 * Suggest a seasonal frequency (days between actions) from the action history.
 * For each consecutive pair of actions of the given type, the elapsed days are
 * attributed to the season in which the earlier action happened, then averaged
 * per season. Seasons without enough data are omitted.
 */
export function computeSeasonalSuggestions(
	actions: PlantAction[],
	type: 'water' | 'fertilize',
): Partial<SeasonalSchedule> {
	const times = actions
		.filter((a) => a.type === type)
		.map((a) => new Date(a.date).getTime())
		.filter((time) => !Number.isNaN(time))
		.sort((a, b) => a - b);

	if (times.length < 2) return {};

	const buckets: Record<Season, number[]> = { spring: [], summer: [], autumn: [], winter: [] };
	for (let i = 1; i < times.length; i++) {
		const deltaDays = (times[i] - times[i - 1]) / (1000 * 60 * 60 * 24);
		if (deltaDays <= 0) continue;
		const season = getSeasonForDate(new Date(times[i - 1]));
		buckets[season].push(deltaDays);
	}

	const result: Partial<SeasonalSchedule> = {};
	(Object.keys(buckets) as Season[]).forEach((season) => {
		const deltas = buckets[season];
		if (deltas.length === 0) return;
		const avg = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
		result[season] = Math.max(1, Math.round(avg));
	});
	return result;
}
