import { store } from "./store";
import { publishAllPlants } from "./mqtt";

let timeout: NodeJS.Timeout | null = null;
const UPDATE_INTERVAL_MS = 60 * 1000;

export function startScheduler(): void {
    // Clear any existing timeout
    if (timeout) {
        clearTimeout(timeout);
    }

    const tick = () => {
        try {
            publishAllPlants(store.getPlants());
        } catch(err) {
            console.error('[Scheduler] Publish failed:', (err as Error).message);
        }

        timeout = setTimeout(tick, UPDATE_INTERVAL_MS);
		timeout.unref();
    }

	timeout = setTimeout(tick, UPDATE_INTERVAL_MS);
	timeout.unref();

    console.log(`[Scheduler] Started, republishing every ${UPDATE_INTERVAL_MS} ms`);
}

export function stopScheduler(): void {
	if (!timeout) return;
	clearTimeout(timeout);
	timeout = null;
	console.log('[Scheduler] Stopped');
}
