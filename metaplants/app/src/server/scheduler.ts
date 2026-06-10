import { store } from "./store";
import { publishAllPlants } from "./mqtt";

let timeout: NodeJS.Timeout | null = null

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


    // TODO Schedule the next run at midnight
}