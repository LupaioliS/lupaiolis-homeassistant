import mqtt from 'mqtt';
import type { Plant } from '../shared/types';
import { DAY_MS, describeDue, getCurrentSeason, getIntervalForSeason } from '../shared/schedule';
import { assessSoil } from '../shared/soil';
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

	// Soil humidity on the plant's own learned scale: 0% = "you water it around here",
	// 100% = "just watered". Recalibrated on every logged watering, so it stays
	// comparable over time while the raw sensor % drifts.
	client.publish(
		`${DISCOVERY_PREFIX}/sensor/${deviceId}/soil_humidity_ai/config`,
		JSON.stringify({
			name: `${plant.name} ${mt('entities.soil_humidity_ai')}`,
			object_id: `${slug}_soil_humidity_ai`,
			unique_id: `${deviceId}_soil_humidity_ai`,
			state_topic: `${TOPIC_PREFIX}/plant/${slug}/soil_humidity_ai`,
			json_attributes_topic: `${TOPIC_PREFIX}/plant/${slug}/attributes`,
			device_class: 'humidity',
			state_class: 'measurement',
			unit_of_measurement: '%',
			device,
			icon: 'mdi:brain',
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

// Mirrors the client-side getStatus(): hour-aware granularity within 24h, days otherwise.
function getActionStatus(lastAction: string | undefined, intervalDays: number, neverKey: string): string {
	if (!lastAction) return mt(neverKey);

	const due = describeDue(lastAction, intervalDays);
	if (due.dueAt === null) return mt(neverKey);

	if (due.overdue) {
		if (due.overdueMs < DAY_MS) {
			return `${mt('status.hoursAgo', { hours: due.overdueHours })} (${mt('status.overdue')})`;
		}
		return `${mt('status.daysAgo', { days: due.overdueDays })} (${mt('status.overdue')})`;
	}

	if (due.remainingMs < DAY_MS) return mt('status.inHours', { hours: due.remainingHours });
	if (due.remainingDays <= 1) return mt('status.tomorrow');
	return mt('status.inDays', { days: due.remainingDays });
}

function publishState(plant: Plant) {
	if (!client?.connected) return;

	const slug = slugify(plant.name);
	const season = getCurrentSeason();
	const wateringIntervalDays = getIntervalForSeason(plant.wateringSchedule, season, plant.wateringIntervalDays ?? 3);
	const fertilizingIntervalDays = getIntervalForSeason(plant.fertilizingSchedule, season, plant.fertilizingIntervalDays ?? 14);

	// Watering state — il terreno secco vince sul programma a tempo. "Secco" lo decide
	// la scala calibrata (shared/soil.ts): la lettura grezza deriva, la scala si ritara
	// ad ogni irrigazione registrata. Stessa funzione usata dal client, così l'allerta
	// in Home Assistant e la scheda nell'app non possono dire cose diverse.
	const currentReadings = getReadings(plant.id);
	const prediction = currentReadings?.prediction;
	const soil = assessSoil(plant.sensors, currentReadings?.soilHumidity, prediction);
	const waterState = soil.needsWater
		? mt(soil.source === 'ai' ? 'status.aiSoilWater' : 'status.soilSensorWater')
		: getActionStatus(plant.lastWatered, wateringIntervalDays, 'watering.never');
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/watering`, waterState);
	publishIfChanged(`${TOPIC_PREFIX}/plant/${slug}/soil_needs_water`, soil.needsWater ? 'ON' : 'OFF');
	// La % sulla scala della pianta, come entità a sé: è quella su cui ha senso
	// costruire automazioni, non la grezza che si scalibra.
	publishIfChanged(
		`${TOPIC_PREFIX}/plant/${slug}/soil_humidity_ai`,
		soil.normalized != null ? String(soil.normalized) : '',
	);

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
		// Stima interna (predict.ts): utile per automazioni "innaffia quando manca poco"
		// senza dover creare entità dedicate.
		prediction: prediction
			? {
				next_watering: prediction.nextWateringAt,
				days_left: prediction.daysLeft,
				confidence: prediction.confidence,
				source: prediction.source,
				dry_rate_per_day: prediction.dryRatePerDay,
				soil_dry_point: prediction.calibration?.dryPoint ?? null,
				soil_wet_point: prediction.calibration?.wetPoint ?? null,
				soil_humidity_calibrated: prediction.normalizedSoilHumidity,
				// Da quante irrigazioni registrate viene la scala e quando è stata
				// ritarata l'ultima volta: 0 / null = sta ancora usando la soglia manuale.
				soil_calibrated_from: prediction.calibration?.samples ?? 0,
				soil_calibrated_at: prediction.calibration?.lastCalibratedAt ?? null,
				// Le singole irrigazioni dietro ai due punti: senza queste, una lettura
				// anomala in un ciclo sposta la scala e non si vede da nessuna parte.
				soil_calibration_cycles: prediction.calibration?.observations ?? [],
			}
			: null,
		// Lettura grezza del sensore e chi sta facendo scattare l'allerta ('ai' = scala
		// calibrata, 'raw' = soglia manuale, 'none' = nessun sensore terreno).
		soil_humidity_raw: soil.raw,
		soil_alert_source: soil.source,
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
