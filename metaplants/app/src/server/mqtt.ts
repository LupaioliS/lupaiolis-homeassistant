import mqtt from 'mqtt';
import type { Plant } from '../shared/types';
import { store } from './store';
import { broadcast } from './events';
import { mt } from './i18n';

const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const MQTT_USER = process.env.MQTT_USER || '';
const MQTT_PASS = process.env.MQTT_PASS || '';
const DISCOVERY_PREFIX = process.env.HA_DISCOVERY_PREFIX || 'homeassistant';
const TOPIC_PREFIX = 'metaplants';

let client: mqtt.MqttClient | null = null;
const discoveredPlants = new Set<string>();

export function connectMqtt(): Promise<void> {
	return new Promise((resolve, reject) => {
		client = mqtt.connect(MQTT_URL, {
			username: MQTT_USER || undefined,
			password: MQTT_PASS || undefined,
			clientId: 'metaplants_' + Math.random().toString(16).slice(2, 8),
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
			resolve();
		});

		client.on('message', handleCommand);

		client.on('error', (err) => {
			console.error('[MQTT] Connection error:', err.message);
			reject(err);
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
	const result = store.addAction(plant.id, action, notes);
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

function publishState(plant: Plant) {
	if (!client?.connected) return;

	const slug = slugify(plant.name);

	// Watering state
	const waterDays = daysAgo(plant.lastWatered);
	const waterState = waterDays === null
		? mt('watering.never')
		: waterDays >= plant.wateringIntervalDays
			? mt('watering.overdue')
			: mt('watering.ok', { days: plant.wateringIntervalDays - waterDays });
	client.publish(`${TOPIC_PREFIX}/plant/${slug}/watering`, waterState, { retain: true });

	// Fertilizing state
	const fertDays = daysAgo(plant.lastFertilized);
	const fertState = fertDays === null
		? mt('fertilizing.never')
		: fertDays >= plant.fertilizingIntervalDays
			? mt('fertilizing.overdue')
			: mt('fertilizing.ok', { days: plant.fertilizingIntervalDays - fertDays });
	client.publish(`${TOPIC_PREFIX}/plant/${slug}/fertilizing`, fertState, { retain: true });

	// Repotting state
	const repotDays = daysAgo(plant.lastRepotted);
	const repotState = repotDays === null ? mt('repotting.never') : mt('repotting.daysAgo', { days: repotDays });
	client.publish(`${TOPIC_PREFIX}/plant/${slug}/repotting`, repotState, { retain: true });

	// Pruning state
	const pruneDays = daysAgo(plant.lastPruned);
	const pruneState = pruneDays === null ? mt('pruning.never') : mt('pruning.daysAgo', { days: pruneDays });
	client.publish(`${TOPIC_PREFIX}/plant/${slug}/pruning`, pruneState, { retain: true });

	// Health state
	const activeIssues = (plant.healthIssues ?? []).filter((i) => !i.resolvedDate);
	const healthState = activeIssues.length === 0 ? mt('health.healthy') : mt('health.issues', { count: activeIssues.length });
	client.publish(`${TOPIC_PREFIX}/plant/${slug}/health`, healthState, { retain: true });

	// Health attributes (active + history)
	const healthAttrs = {
		active_issues: activeIssues.map((i) => ({ type: i.type, name: i.name, detected: i.detectedDate })),
		resolved_issues: (plant.healthIssues ?? []).filter((i) => i.resolvedDate).map((i) => ({
			type: i.type, name: i.name, detected: i.detectedDate, resolved: i.resolvedDate, treatment: i.treatment,
		})),
	};
	client.publish(`${TOPIC_PREFIX}/plant/${slug}/health_attributes`, JSON.stringify(healthAttrs), { retain: true });

	// Full attributes
	const attributes = {
		species: plant.species,
		location: plant.location,
		purchase_date: plant.purchaseDate || null,
		watering_interval_days: plant.wateringIntervalDays,
		fertilizing_interval_days: plant.fertilizingIntervalDays,
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
	client.publish(`${TOPIC_PREFIX}/plant/${slug}/attributes`, JSON.stringify(attributes), { retain: true });
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
	const sensorTypes = ['watering', 'fertilizing', 'repotting', 'pruning', 'health'];
	for (const type of sensorTypes) {
		client.publish(`${DISCOVERY_PREFIX}/sensor/${deviceId}/${type}/config`, '', { retain: true });
	}
	const actionTypes = ['water', 'fertilize', 'repot', 'prune'];
	for (const action of actionTypes) {
		client.publish(`${DISCOVERY_PREFIX}/button/${deviceId}/${action}/config`, '', { retain: true });
	}

	// Remove state topics
	const stateTopics = ['watering', 'fertilizing', 'repotting', 'pruning', 'health', 'health_attributes', 'attributes'];
	for (const t of stateTopics) {
		client.publish(`${TOPIC_PREFIX}/plant/${slug}/${t}`, '', { retain: true });
	}
}
