import mqtt from 'mqtt';
import type { Plant, Season, SeasonalSchedule } from '../shared/types';
import { store } from './store';
import { broadcast } from './events';
import { mt } from './i18n';
import { config } from './config';
import { getReadings } from './sensors';

const MQTT_URL = config.mqttUrl;
const MQTT_USER = config.mqttUser;
const MQTT_PASS = config.mqttPass;
const DISCOVERY_PREFIX = config.discoveryPrefix;
const TOPIC_PREFIX = 'metaplants';

let client: mqtt.MqttClient | null = null;
const discoveredPlants = new Set<string>();
const lastPublished = new Map<string, string>();

// Evita di pubblicare retained message identici a ogni tick dello scheduler.
function publishIfChanged(topic: string, payload: string) {
	if (!client?.connected) return;
	if (lastPublished.get(topic) === payload) return;
	lastPublished.set(topic, payload);
	client.publish(topic, payload, { retain: true });
}

export function connectMqtt(): Promise<void> {
	return new Promise((resolve, reject) => {
		const safeUser = MQTT_USER ? MQTT_USER : '(none)';
		console.log('[MQTT] Connecting...');
		console.log('[MQTT]   URL            :', MQTT_URL);
		console.log('[MQTT]   User           :', safeUser);
		console.log('[MQTT]   Password set   :', MQTT_PASS ? 'yes' : 'no');
		console.log('[MQTT]   Discovery prefix:', DISCOVERY_PREFIX);

		let settled = false;

		client = mqtt.connect(MQTT_URL, {
			username: MQTT_USER || undefined,
			password: MQTT_PASS || undefined,
			clientId: 'metaplants_' + Math.random().toString(16).slice(2, 8),
			reconnectPeriod: 5000,
			will: {
				topic: TOPIC_PREFIX + '/status',
				payload: Buffer.from('offline'),
				retain: true,
				qos: 1,
			},
		});

		client.on('connect', () => {
			console.log('[MQTT] Connected to', MQTT_URL);
			client!.publish(TOPIC_PREFIX + '/status', 'online', { retain: true });
			// Subscribe to command topics
			client!.subscribe(TOPIC_PREFIX + '/+/+/set', (err) => {
				if (err) console.error('[MQTT] Subscribe error:', err.message);
				else console.log('[MQTT] Subscribed to command topics');
			});
			if (!settled) {
				settled = true;
				resolve();
			}
		});

		client.on('message', handleCommand);

		client.on('reconnect', () => {
			console.warn('[MQTT] Reconnecting to', MQTT_URL, '...');
		});

		client.on('close', () => {
			console.warn('[MQTT] Connection closed');
		});

		client.on('error', (err) => {
			const e = err as NodeJS.ErrnoException & { address?: string; port?: number };
			console.error('[MQTT] Connection error while connecting to', MQTT_URL);
			console.error('[MQTT]   message:', e.message || '(empty)');
			if (e.code) console.error('[MQTT]   code   :', e.code);
			if (e.errno) console.error('[MQTT]   errno  :', e.errno);
			if (e.syscall) console.error('[MQTT]   syscall:', e.syscall);
			if (e.address) console.error('[MQTT]   address:', e.address);
			if (e.port) console.error('[MQTT]   port   :', e.port);
			if (!settled) {
				settled = true;
				reject(err);
			}
		});
	});
}

function handleCommand(topic: string, message: Buffer) {
	// Topic format: metaplants/<slug>/<action>/set
	const parts = topic.split('/');
	if (parts.length !== 4 || parts[0] !== TOPIC_PREFIX || parts[3] !== 'set') return;

	const slug = parts[1];
	const action = parts[2] as 'water' | 'fertilize' | 'repot' | 'prune';
	const validActions = ['water', 'fertilize', 'repot', 'prune'];
	if (!validActions.includes(action)) return;

	// Find plant by slug
	const plants = store.getPlants();
	const plant = plants.find((p) => slugify(p.name) === slug);
	if (!plant) {
		console.warn(`[MQTT] Plant not found for slug: ${slug}`);
		return;
	}

	const notes = message.toString() || mt('actions.triggered_from_ha');
	const result = store.addAction(plant.id, action, { notes });
	if (result) {
		const updated = store.getPlant(plant.id);
		if (updated) {
			publishState(updated);
			broadcast({ type: 'plant-updated', plant: updated });
		}
		console.log(`[MQTT] Action '${action}' executed for plant '${plant.name}'`);
	}
}

export function disconnectMqtt(): Promise<void> {
	return new Promise((resolve) => {
		if (!client) return resolve();
		client.publish(TOPIC_PREFIX + '/status', 'offline', { retain: true }, () => {
			client!.end(false, () => resolve());
		});
	});
}

function slugify(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function publishDiscovery(plant: Plant) {
	if (!client?.connected) return;
	// Skip if already discovered this session (prevents duplicates on repeated publishes)
	if (discoveredPlants.has(plant.id)) return;
	discoveredPlants.add(plant.id);

	const slug = slugify(plant.name);
	const deviceId = `metaplants_${plant.id}`;

	const device = {
		identifiers: [deviceId],
		name: plant.name,
		model: plant.species,
		manufacturer: 'MetaPlants',
		suggested_area: plant.location,
	};

	const availability = { topic: TOPIC_PREFIX + '/status' };

	// Watering sensor
	client.publish(
		`${DISCOVERY_PREFIX}/sensor/${deviceId}/watering/config`,
		JSON.stringify({
			name: `${plant.name} ${mt('entities.watering')}`,
			object_id: `${slug}_watering`,
			unique_id: `${deviceId}_watering`,
			state_topic: `${TOPIC_PREFIX}/plant/${slug}/watering`,
			json_attributes_topic: `${TOPIC_PREFIX}/plant/${slug}/attributes`,
			device,
			icon: 'mdi:watering-can',
			availability,
		}),
		{ retain: true }
	);

	// Fertilizing sensor
	client.publish(
		`${DISCOVERY_PREFIX}/sensor/${deviceId}/fertilizing/config`,
		JSON.stringify({
			name: `${plant.name} ${mt('entities.fertilizing')}`,
			object_id: `${slug}_fertilizing`,
			unique_id: `${deviceId}_fertilizing`,
			state_topic: `${TOPIC_PREFIX}/plant/${slug}/fertilizing`,
			json_attributes_topic: `${TOPIC_PREFIX}/plant/${slug}/attributes`,
			device,
			icon: 'mdi:bottle-tonic',
			availability,
		}),
		{ retain: true }
	);

	// Repotting sensor
	client.publish(
		`${DISCOVERY_PREFIX}/sensor/${deviceId}/repotting/config`,
		JSON.stringify({
			name: `${plant.name} ${mt('entities.repotting')}`,
			object_id: `${slug}_repotting`,
			unique_id: `${deviceId}_repotting`,
			state_topic: `${TOPIC_PREFIX}/plant/${slug}/repotting`,
			json_attributes_topic: `${TOPIC_PREFIX}/plant/${slug}/attributes`,
			device,
			icon: 'mdi:flower-pollen',
			availability,
		}),
		{ retain: true }
	);

	// Pruning sensor
	client.publish(
		`${DISCOVERY_PREFIX}/sensor/${deviceId}/pruning/config`,
		JSON.stringify({
			name: `${plant.name} ${mt('entities.pruning')}`,
			object_id: `${slug}_pruning`,
			unique_id: `${deviceId}_pruning`,
			state_topic: `${TOPIC_PREFIX}/plant/${slug}/pruning`,
			json_attributes_topic: `${TOPIC_PREFIX}/plant/${slug}/attributes`,
			device,
			icon: 'mdi:content-cut',
			availability,
		}),
		{ retain: true }
	);

	// Next watering date sensor (for automations)
	client.publish(
		`${DISCOVERY_PREFIX}/sensor/${deviceId}/watering_next/config`,
		JSON.stringify({
			name: `${plant.name} ${mt('entities.watering_next')}`,
			object_id: `${slug}_watering_next`,
			unique_id: `${deviceId}_watering_next`,
			state_topic: `${TOPIC_PREFIX}/plant/${slug}/watering_next`,
			device_class: 'timestamp',
			device,
			icon: 'mdi:watering-can',
			availability,
		}),
		{ retain: true }
	);

	// Soil sensor watering alert (binary, for automations independent of the time-based schedule)
	client.publish(
		`${DISCOVERY_PREFIX}/binary_sensor/${deviceId}/soil_needs_water/config`,
		JSON.stringify({
			name: `${plant.name} ${mt('entities.soil_needs_water')}`,
			object_id: `${slug}_soil_needs_water`,
			unique_id: `${deviceId}_soil_needs_water`,
			state_topic: `${TOPIC_PREFIX}/plant/${slug}/soil_needs_water`,
			device_class: 'problem',
			device,
			icon: 'mdi:water-alert',
			availability,
		}),
		{ retain: true }
	);

	// Next fertilizing date sensor (for automations)
	client.publish(
		`${DISCOVERY_PREFIX}/sensor/${deviceId}/fertilizing_next/config`,
		JSON.stringify({
			name: `${plant.name} ${mt('entities.fertilizing_next')}`,
			object_id: `${slug}_fertilizing_next`,
			unique_id: `${deviceId}_fertilizing_next`,
			state_topic: `${TOPIC_PREFIX}/plant/${slug}/fertilizing_next`,
			device_class: 'timestamp',
			device,
			icon: 'mdi:bottle-tonic',
			availability,
		}),
		{ retain: true }
	);

	// Last repotted date sensor (for automations)
	client.publish(
		`${DISCOVERY_PREFIX}/sensor/${deviceId}/repotting_last/config`,
		JSON.stringify({
			name: `${plant.name} ${mt('entities.repotting_last')}`,
			object_id: `${slug}_repotting_last`,
			unique_id: `${deviceId}_repotting_last`,
			state_topic: `${TOPIC_PREFIX}/plant/${slug}/repotting_last`,
			device_class: 'timestamp',
			device,
			icon: 'mdi:flower-pollen',
			availability,
		}),
		{ retain: true }
	);

	// Last pruned date sensor (for automations)
	client.publish(
		`${DISCOVERY_PREFIX}/sensor/${deviceId}/pruning_last/config`,
		JSON.stringify({
			name: `${plant.name} ${mt('entities.pruning_last')}`,
			object_id: `${slug}_pruning_last`,
			unique_id: `${deviceId}_pruning_last`,
			state_topic: `${TOPIC_PREFIX}/plant/${slug}/pruning_last`,
			device_class: 'timestamp',
			device,
			icon: 'mdi:content-cut',
			availability,
		}),
		{ retain: true }
	);

	// Health sensor
	client.publish(
		`${DISCOVERY_PREFIX}/sensor/${deviceId}/health/config`,
		JSON.stringify({
			name: `${plant.name} ${mt('entities.health')}`,
			object_id: `${slug}_health`,
			unique_id: `${deviceId}_health`,
			state_topic: `${TOPIC_PREFIX}/plant/${slug}/health`,
			json_attributes_topic: `${TOPIC_PREFIX}/plant/${slug}/health_attributes`,
			device,
			icon: 'mdi:heart-pulse',
			availability,
		}),
		{ retain: true }
	);

	// Action buttons for HA
	const actions = [
		{ action: 'water', name: mt('entities.water_btn'), icon: 'mdi:watering-can' },
		{ action: 'fertilize', name: mt('entities.fertilize_btn'), icon: 'mdi:bottle-tonic' },
		{ action: 'repot', name: mt('entities.repot_btn'), icon: 'mdi:flower-pollen' },
		{ action: 'prune', name: mt('entities.prune_btn'), icon: 'mdi:content-cut' },
	];

	for (const { action, name, icon } of actions) {
		client.publish(
			`${DISCOVERY_PREFIX}/button/${deviceId}/${action}/config`,
			JSON.stringify({
				name: `${plant.name} ${name}`,
				object_id: `${slug}_${action}`,
				unique_id: `${deviceId}_btn_${action}`,
				command_topic: `${TOPIC_PREFIX}/${slug}/${action}/set`,
				device,
				icon,
				availability,
			}),
			{ retain: true }
		);
	}
}

function daysAgo(dateStr?: string): number | null {
	if (!dateStr) return null;
	return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function getCurrentSeason(): Season {
	const month = new Date().getMonth();
	if (month >= 2 && month <= 4) return 'spring';
	if (month >= 5 && month <= 7) return 'summer';
	if (month >= 8 && month <= 10) return 'autumn';
	return 'winter';
}

function getSeasonalInterval(schedule: SeasonalSchedule | undefined, season: Season, fallback: number): number {
	const value = schedule?.[season];
	if (typeof value === 'number' && value > 0) return value;
	return fallback;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Mirrors the client-side getStatus(): hour-aware granularity within 24h, days otherwise.
function getActionStatus(lastAction: string | undefined, intervalDays: number, neverKey: string): string {
	if (!lastAction) return mt(neverKey);

	const elapsedMs = Date.now() - new Date(lastAction).getTime();
	const daysAgo = Math.floor(elapsedMs / DAY_MS);
	const hoursAgo = Math.floor(elapsedMs / HOUR_MS);
	const intervalMs = intervalDays * DAY_MS;

	if (elapsedMs >= intervalMs) {
		if (elapsedMs < DAY_MS) {
			return `${mt('status.hoursAgo', { hours: hoursAgo })} (${mt('status.overdue')})`;
		}
		return `${mt('status.daysAgo', { days: daysAgo })} (${mt('status.overdue')})`;
	}

	const remainingMs = intervalMs - elapsedMs;
	if (remainingMs < DAY_MS) {
		const remainingHours = Math.max(1, Math.ceil(remainingMs / HOUR_MS));
		return mt('status.inHours', { hours: remainingHours });
	}

	const remainingDays = Math.ceil(remainingMs / DAY_MS);
	return mt('status.inDays', { days: remainingDays });
}

function publishState(plant: Plant) {
	if (!client?.connected) return;

	const slug = slugify(plant.name);
	const season = getCurrentSeason();
	const wateringIntervalDays = getSeasonalInterval(plant.wateringSchedule, season, plant.wateringIntervalDays ?? 3);
	const fertilizingIntervalDays = getSeasonalInterval(plant.fertilizingSchedule, season, plant.fertilizingIntervalDays ?? 14);

	// Watering state — il sensore di umidità del terreno, se sotto soglia, vince sul programma a tempo.
	const soilThreshold = plant.sensors?.soilHumidityThreshold;
	const soilHumidity = getReadings(plant.id)?.soilHumidity;
	const soilNeedsWater = soilThreshold != null && soilHumidity != null && soilHumidity <= soilThreshold;
	const waterState = soilNeedsWater
		? mt('status.soilSensorWater')
		: getActionStatus(plant.lastWatered, wateringIntervalDays, 'watering.never');
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/watering`, waterState);
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/soil_needs_water`, soilNeedsWater ? 'ON' : 'OFF');

	// Fertilizing state
	const fertState = getActionStatus(plant.lastFertilized, fertilizingIntervalDays, 'fertilizing.never');
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/fertilizing`, fertState);

	// Repotting state
	const repotDays = daysAgo(plant.lastRepotted);
	const repotState = repotDays === null ? mt('repotting.never') : mt('repotting.daysAgo', { days: repotDays });
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/repotting`, repotState);

	// Pruning state
	const pruneDays = daysAgo(plant.lastPruned);
	const pruneState = pruneDays === null ? mt('pruning.never') : mt('pruning.daysAgo', { days: pruneDays });
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/pruning`, pruneState);

	// Next watering/fertilizing dates, last repotted/pruned dates — for automations (ISO 8601, device_class timestamp)
	const nextWatering = plant.lastWatered
		? new Date(new Date(plant.lastWatered).getTime() + wateringIntervalDays * DAY_MS).toISOString()
		: '';
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/watering_next`, nextWatering);

	const nextFertilizing = plant.lastFertilized
		? new Date(new Date(plant.lastFertilized).getTime() + fertilizingIntervalDays * DAY_MS).toISOString()
		: '';
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/fertilizing_next`, nextFertilizing);

	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/repotting_last`, plant.lastRepotted || '');
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/pruning_last`, plant.lastPruned || '');

	// Health state
	const activeIssues = (plant.healthIssues ?? []).filter((i) => !i.resolvedDate);
	const healthState = activeIssues.length === 0 ? mt('health.healthy') : mt('health.issues', { count: activeIssues.length });
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/health`, healthState);

	// Health attributes (active + history)
	const healthAttrs = {
		active_issues: activeIssues.map((i) => ({ type: i.type, name: i.name, detected: i.detectedDate })),
		resolved_issues: (plant.healthIssues ?? []).filter((i) => i.resolvedDate).map((i) => ({
			type: i.type, name: i.name, detected: i.detectedDate, resolved: i.resolvedDate, treatment: i.treatment,
		})),
	};
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/health_attributes`, JSON.stringify(healthAttrs));

	// Full attributes
	const attributes = {
		species: plant.species,
		location: plant.location,
		purchase_date: plant.purchaseDate || null,
		watering_interval_days: wateringIntervalDays,
		fertilizing_interval_days: fertilizingIntervalDays,
		last_watered: plant.lastWatered || null,
		last_fertilized: plant.lastFertilized || null,
		last_repotted: plant.lastRepotted || null,
		last_pruned: plant.lastPruned || null,
		recommended_fertilizer: plant.recommendedFertilizer || null,
		watering_schedule: plant.wateringSchedule || null,
		fertilizing_schedule: plant.fertilizingSchedule || null,
		product_history: (plant.productHistory ?? []).map((p) => ({
			product: p.productName, date: p.date, reason: p.reason,
		})),
		notes: plant.notes || null,
	};
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/attributes`, JSON.stringify(attributes));
}

export function publishPlant(plant: Plant) {
	publishDiscovery(plant);
	publishState(plant);
}

export function republishPlant(plant: Plant) {
	// Force re-discovery (e.g. after name/species change)
	discoveredPlants.delete(plant.id);
	publishDiscovery(plant);
	publishState(plant);
}

export function publishAllPlants(plants: Plant[]) {
	for (const plant of plants) {
		publishPlant(plant);
	}
}

export function removePlant(plant: Plant) {
	if (!client?.connected) return;

	const deviceId = `metaplants_${plant.id}`;
	const slug = slugify(plant.name);
	discoveredPlants.delete(plant.id);

	// Remove discovery configs
	const sensorTypes = ['watering', 'fertilizing', 'repotting', 'pruning', 'health', 'watering_next', 'fertilizing_next', 'repotting_last', 'pruning_last'];
	for (const type of sensorTypes) {
		client.publish(`${DISCOVERY_PREFIX}/sensor/${deviceId}/${type}/config`, '', { retain: true });
	}
	client.publish(`${DISCOVERY_PREFIX}/binary_sensor/${deviceId}/soil_needs_water/config`, '', { retain: true });
	const actionTypes = ['water', 'fertilize', 'repot', 'prune'];
	for (const action of actionTypes) {
		client.publish(`${DISCOVERY_PREFIX}/button/${deviceId}/${action}/config`, '', { retain: true });
	}

	// Remove state topics
	const stateTopics = ['watering', 'fertilizing', 'repotting', 'pruning', 'health', 'health_attributes', 'attributes', 'watering_next', 'fertilizing_next', 'repotting_last', 'pruning_last', 'soil_needs_water'];
	for (const t of stateTopics) {
		const topic = `${TOPIC_PREFIX}/plant/${slug}/${t}`;
		client.publish(topic, '', { retain: true });
		lastPublished.delete(topic);
	}
}
