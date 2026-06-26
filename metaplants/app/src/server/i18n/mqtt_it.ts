export const mqtt_it = {
	status: {
		online: 'online',
		offline: 'offline',
		overdue: 'scaduto!',
		daysAgo: '{days}g fa',
		hoursAgo: '{hours}h fa',
		inDays: 'tra {days}g',
		inHours: 'tra {hours}h',
		soilSensorWater: 'da irrigare (sensore terreno)',
	},
	watering: {
		never: 'mai irrigata',
		overdue: 'da irrigare',
		ok: 'ok ({days}g rimanenti)',
	},
	fertilizing: {
		never: 'mai fertilizzata',
		overdue: 'da fertilizzare',
		ok: 'ok ({days}g rimanenti)',
	},
	repotting: {
		never: 'mai rinvasata',
		daysAgo: '{days}g fa',
	},
	pruning: {
		never: 'mai potata',
		daysAgo: '{days}g fa',
	},
	health: {
		healthy: 'sana',
		issues: '{count} problema/i',
	},
	entities: {
		watering: 'Irrigazione',
		fertilizing: 'Fertilizzazione',
		repotting: 'Rinvaso',
		pruning: 'Potatura',
		health: 'Salute',
		water_btn: 'Irriga',
		fertilize_btn: 'Fertilizza',
		repot_btn: 'Rinvasa',
		prune_btn: 'Potatura',
	},
	actions: {
		triggered_from_ha: 'Eseguito da Home Assistant',
	},
};
