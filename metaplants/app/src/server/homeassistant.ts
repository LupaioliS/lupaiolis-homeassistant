const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;

// In add-on: proxy del Supervisor. In dev: override via env (LLAT + URL HA).
const HA_BASE_URL = SUPERVISOR_TOKEN
	? 'http://supervisor/core/api'
	: (process.env.HASS_URL || 'http://homeassistant.local:8123/api');

const HA_TOKEN = SUPERVISOR_TOKEN || process.env.HASS_TOKEN || '';

export interface EntityState {
	entityId: string;
	state: string; // sempre stringa in HA
	value: number | null; // comodità: state convertito a numero
	unit?: string;
	attributes: Record<string, unknown>;
	lastUpdated?: string;
}

export function isHaAvailable(): boolean {
	return Boolean(HA_TOKEN);
}

export async function getEntityState(entityId: string): Promise<EntityState | null> {
	if (!HA_TOKEN) return null; // dev senza credenziali: no-op pulito

	try {
		const res = await fetch(`${HA_BASE_URL}/states/${encodeURIComponent(entityId)}`, {
			headers: {
				Authorization: `Bearer ${HA_TOKEN}`,
				'Content-Type': 'application/json',
			},
		});

		if (res.status === 404) {
			console.warn(`[HA] Entity not found: ${entityId}`);
			return null;
		}
		if (!res.ok) {
			console.error(`[HA] States request failed (${res.status}) for ${entityId}`);
			return null;
		}

		const data = (await res.json()) as {
			entity_id: string;
			state: string;
			attributes?: Record<string, unknown>;
			last_updated?: string;
		};

		const num = Number(data.state);
		return {
			entityId: data.entity_id,
			state: data.state,
			value: Number.isFinite(num) ? num : null,
			unit: data.attributes?.unit_of_measurement as string | undefined,
			attributes: data.attributes ?? {},
			lastUpdated: data.last_updated,
		};
	} catch (err) {
		console.error(`[HA] Error reading ${entityId}:`, (err as Error).message);
		return null;
	}
}