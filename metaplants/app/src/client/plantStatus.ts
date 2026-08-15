// Il calcolo di scadenze e giorni residui è condiviso con il server (MQTT pubblica
// le stesse stringhe): vive in src/shared/schedule.ts perché client e server
// mostrassero numeri diversi era proprio il bug del "tra tot giorni".
export { getIntervalForSeason, isOverdue, describeDue, calendarDaysBetween, DAY_MS, HOUR_MS } from '../shared/schedule';
export type { DueInfo } from '../shared/schedule';
