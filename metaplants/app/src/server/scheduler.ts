import { store } from "./store";
import { publishAllPlants } from "./mqtt";

let timeout: NodeJS.Timeout | null = null;
const HOURLY_INTERVAL_MS = 60 * 60 * 1000;

export function startHourlyScheduler(): void {
    // Clear any existing timeout
    if (timeout) {
        clearTimeout(timeout);
    }

    const tick = () => {
        try {
            publishAllPlants(store.getPlants());
            console.log('[Scheduler] Hourly republish done');
        } catch(err) {
            console.error('[Scheduler] Publish failed:', (err as Error).message);
        }

        timeout = setTimeout(tick, HOURLY_INTERVAL_MS);
		timeout.unref();
    }

	timeout = setTimeout(tick, HOURLY_INTERVAL_MS);
	timeout.unref();

    console.log(`[Scheduler] Started, next run in ${HOURLY_INTERVAL_MS} ms`);
}

export function stopHourlyScheduler(): void {
	if (!timeout) return;
	clearTimeout(timeout);
	timeout = null;
	console.log('[Scheduler] Stopped');
}