import fs from 'fs';
import path from 'path';

/**
 * Home Assistant add-on options are written to /data/options.json (NOT env vars).
 * This loader reads that file and merges it with environment variables so the
 * app works both as a HA add-on and in local/dev mode.
 */
interface HaOptions {
	mqtt_url?: string;
	mqtt_user?: string;
	mqtt_pass?: string;
	ha_discovery_prefix?: string;
	lang?: string;
	sensor_poll_seconds?: number;
}

// Limiti di sicurezza: sotto i 5s si martella Home Assistant senza guadagno reale,
// sopra i 5 minuti il prompt "hai innaffiato?" arriverebbe troppo tardi.
const MIN_POLL_SECONDS = 5;
const MAX_POLL_SECONDS = 300;
const DEFAULT_POLL_SECONDS = 20;

function readPollSeconds(raw: unknown): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_POLL_SECONDS;
	return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(value)));
}

function readHaOptions(): HaOptions {
	const dataDir = process.env.DATA_DIR || '/data';
	const optionsPath = path.join(dataDir, 'options.json');
	try {
		if (fs.existsSync(optionsPath)) {
			const raw = fs.readFileSync(optionsPath, 'utf-8');
			const parsed = JSON.parse(raw) as HaOptions;
			console.log('[Config] Loaded Home Assistant options from', optionsPath);
			return parsed;
		}
		console.log('[Config] No HA options file at', optionsPath, '- using environment variables');
	} catch (err) {
		console.error('[Config] Failed to read HA options:', (err as Error).message);
	}
	return {};
}

const haOptions = readHaOptions();

export interface AppConfig {
	mqttUrl: string;
	mqttUser: string;
	mqttPass: string;
	discoveryPrefix: string;
	lang: string;
	/** Ogni quanto rileggere i sensori da Home Assistant. */
	sensorPollSeconds: number;
}

export const config: AppConfig = {
	mqttUrl: haOptions.mqtt_url || process.env.MQTT_URL || 'mqtt://localhost:1883',
	mqttUser: haOptions.mqtt_user ?? process.env.MQTT_USER ?? '',
	mqttPass: haOptions.mqtt_pass ?? process.env.MQTT_PASS ?? '',
	discoveryPrefix: haOptions.ha_discovery_prefix || process.env.HA_DISCOVERY_PREFIX || 'homeassistant',
	lang: haOptions.lang || process.env.METAPLANTS_LANG || 'it',
	sensorPollSeconds: readPollSeconds(haOptions.sensor_poll_seconds ?? process.env.SENSOR_POLL_SECONDS),
};
