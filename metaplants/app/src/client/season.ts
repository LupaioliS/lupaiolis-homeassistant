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
 *
 * È il ripiego per le piante senza sensore: quando c'è una stima matura il
 * suggerimento arriva dalla curva (`prediction.fullCycleDays`), che misura la
 * pianta invece delle abitudini di chi la innaffia.
 */
export function computeSeasonalSuggestions(
	actions: PlantAction[],
	type: 'water' | 'fertilize',
): Partial<SeasonalSchedule> {
	const events = actions
		.filter((a) => a.type === type)
		.map((a) => ({ at: new Date(a.date).getTime(), source: a.source }))
		.filter((e) => !Number.isNaN(e.at))
		.sort((a, b) => a.at - b.at);

	if (events.length < 2) return {};

	const buckets: Record<Season, number[]> = { spring: [], summer: [], autumn: [], winter: [] };
	for (let i = 1; i < events.length; i++) {
		// Un divario che comincia o finisce con una pioggia non dice ogni quanto
		// devi innaffiare TU: dice che ha piovuto. Si scarta la coppia invece di
		// togliere l'evento, perché toglierlo fonderebbe due divari brevi in uno
		// lungo e il suggerimento sbaglierebbe dalla parte opposta.
		if (events[i].source === 'rain' || events[i - 1].source === 'rain') continue;
		const deltaDays = (events[i].at - events[i - 1].at) / (1000 * 60 * 60 * 24);
		if (deltaDays <= 0) continue;
		const season = getSeasonForDate(new Date(events[i - 1].at));
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
