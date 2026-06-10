import { store } from "./store";
import { publishAllPlants } from "./mqtt";

let timeout: NodeJS.Timeout | null = null;

function msUntilNextMidnight(): number {
    const next = new Date();
    next.setHours(24, 0, 5, 0); //<-- 5 seconds after midnight to be safe
    return next.getTime() - Date.now();
}


export function startDaylyScheduler(): void {
    // Clear any existing timeout
    if (timeout) {
        clearTimeout(timeout);
    }

    const tick = () => {
        try {
            publishAllPlants(store.getPlants());
            console.log('[Scheduler] Daily republish done');
        } catch(err) {
            console.error('[Scheduler] Publish failed:', (err as Error).message);
        }

        timeout = setTimeout(tick, msUntilNextMidnight());
		timeout.unref();
    }

    timeout = setTimeout(tick, msUntilNextMidnight());
	timeout.unref();

    console.log(`[Scheduler] Started, next run in ${msUntilNextMidnight()} ms`);
}

export function stopDailyScheduler(): void {
	if (!timeout) return;
	clearTimeout(timeout);
	timeout = null;
	console.log('[Scheduler] Stopped');
}