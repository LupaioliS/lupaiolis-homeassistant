import mqtt from 'mqtt';
import type { Plant } from '../shared/types';

const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const MQTT_USER = process.env.MQTT_USER || '';
const MQTT_PASS = process.env.MQTT_PASS || '';
const DISCOVERY_PREFIX = process.env.HA_DISCOVERY_PREFIX || 'homeassistant';
const TOPIC_PREFIX = 'metaplants';

let client: mqtt.MqttClient | null = null;

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
			resolve();
		});

		client.on('error', (err) => {
			console.error('[MQTT] Connection error:', err.message);
			reject(err);
		});
	});
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

	const slug = slugify(plant.name);
	const deviceId = 'metaplants_' + plant.id.slice(0, 8);

	const device = {
		identifiers: [deviceId],
		name: plant.name,
		model: plant.species,
		manufacturer: 'MetaPlants',
		suggested_area: plant.location,
	};

	// Watering sensor
	const waterConfig = {
		name: plant.name + ' Irrigazione',
		unique_id: deviceId + '_watering',
		state_topic: TOPIC_PREFIX + '/plant/' + slug + '/watering',
		json_attributes_topic: TOPIC_PREFIX + '/plant/' + slug + '/attributes',
		device,
		icon: 'mdi:watering-can',
		availability_topic: TOPIC_PREFIX + '/status',
	};

	// Fertilizing sensor
	const fertConfig = {
		name: plant.name + ' Fertilizzazione',
		unique_id: deviceId + '_fertilizing',
		state_topic: TOPIC_PREFIX + '/plant/' + slug + '/fertilizing',
		json_attributes_topic: TOPIC_PREFIX + '/plant/' + slug + '/attributes',
		device,
		icon: 'mdi:bottle-tonic',
		availability_topic: TOPIC_PREFIX + '/status',
	};

	client.publish(
		DISCOVERY_PREFIX + '/sensor/' + deviceId + '/watering/config',
		JSON.stringify(waterConfig),
		{ retain: true }
	);
	client.publish(
		DISCOVERY_PREFIX + '/sensor/' + deviceId + '/fertilizing/config',
		JSON.stringify(fertConfig),
		{ retain: true }
	);
}

function publishState(plant: Plant) {
	if (!client?.connected) return;

	const slug = slugify(plant.name);

	const waterDaysAgo = plant.lastWatered
		? Math.floor((Date.now() - new Date(plant.lastWatered).getTime()) / 86400000)
		: null;
	const fertDaysAgo = plant.lastFertilized
		? Math.floor((Date.now() - new Date(plant.lastFertilized).getTime()) / 86400000)
		: null;

	const waterState = waterDaysAgo === null
		? 'mai irrigata'
		: waterDaysAgo >= plant.wateringIntervalDays
			? 'da irrigare'
			: 'ok (' + (plant.wateringIntervalDays - waterDaysAgo) + 'g rimanenti)';

	const fertState = fertDaysAgo === null
		? 'mai fertilizzata'
		: fertDaysAgo >= plant.fertilizingIntervalDays
			? 'da fertilizzare'
			: 'ok (' + (plant.fertilizingIntervalDays - fertDaysAgo) + 'g rimanenti)';

	client.publish(TOPIC_PREFIX + '/plant/' + slug + '/watering', waterState, { retain: true });
	client.publish(TOPIC_PREFIX + '/plant/' + slug + '/fertilizing', fertState, { retain: true });

	const attributes = {
		species: plant.species,
		location: plant.location,
		watering_interval_days: plant.wateringIntervalDays,
		fertilizing_interval_days: plant.fertilizingIntervalDays,
		last_watered: plant.lastWatered || null,
		last_fertilized: plant.lastFertilized || null,
		notes: plant.notes || null,
	};
	client.publish(TOPIC_PREFIX + '/plant/' + slug + '/attributes', JSON.stringify(attributes), { retain: true });
}

export function publishPlant(plant: Plant) {
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

	const deviceId = 'metaplants_' + plant.id.slice(0, 8);
	const slug = slugify(plant.name);

	// Remove discovery configs
	client.publish(DISCOVERY_PREFIX + '/sensor/' + deviceId + '/watering/config', '', { retain: true });
	client.publish(DISCOVERY_PREFIX + '/sensor/' + deviceId + '/fertilizing/config', '', { retain: true });

	// Remove state
	client.publish(TOPIC_PREFIX + '/plant/' + slug + '/watering', '', { retain: true });
	client.publish(TOPIC_PREFIX + '/plant/' + slug + '/fertilizing', '', { retain: true });
	client.publish(TOPIC_PREFIX + '/plant/' + slug + '/attributes', '', { retain: true });
}
