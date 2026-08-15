import type { HaEntityList, HaEntityOption } from '../shared/types';

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;

// In add-on: proxy del Supervisor. In dev: override via env (LLAT + URL HA).
const HA_BASE_URL = SUPERVISOR_TOKEN
	? 'http://supervisor/core/api'
	: (process.env.HASS_URL || 'http://homeassistant.local:8123/api');

const HA_TOKEN = SUPERVISOR_TOKEN || process.env.HASS_TOKEN || '';

// Etichetta (label) di Home Assistant che marca i sensori da proporre nel form.
export const METAPLANTS_LABEL = process.env.METAPLANTS_LABEL || 'metaplants';

// device_class utili a MetaPlants, in ordine di rilevanza per ciascun campo del form.
const RELEVANT_DEVICE_CLASSES = ['temperature', 'humidity', 'moisture'];

const ENTITY_CACHE_MS = 60_000;

export interface EntityState {
	entityId: string;
	state: string; // sempre stringa in HA
	value: number | null; // comodità: state convertito a numero
	unit?: string;
	attributes: Record<string, unknown>;
	lastUpdated?: string;
}

interface RawState {
	entity_id: string;
	state: string;
	attributes?: Record<string, unknown>;
	last_updated?: string;
}

export function isHaAvailable(): boolean {
	return Boolean(HA_TOKEN);
}

function authHeaders(): Record<string, string> {
	return {
		Authorization: `Bearer ${HA_TOKEN}`,
		'Content-Type': 'application/json',
	};
}

export async function getEntityState(entityId: string): Promise<EntityState | null> {
	if (!HA_TOKEN) return null; // dev senza credenziali: no-op pulito

	try {
		const res = await fetch(`${HA_BASE_URL}/states/${encodeURIComponent(entityId)}`, {
			headers: authHeaders(),
		});

		if (res.status === 404) {
			console.warn(`[HA] Entity not found: ${entityId}`);
			return null;
		}
		if (!res.ok) {
			console.error(`[HA] States request failed (${res.status}) for ${entityId}`);
			return null;
		}

		const data = (await res.json()) as RawState;
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

async function getAllStates(): Promise<RawState[]> {
	if (!HA_TOKEN) return [];
	try {
		const res = await fetch(`${HA_BASE_URL}/states`, { headers: authHeaders() });
		if (!res.ok) {
			console.error(`[HA] States list failed (${res.status})`);
			return [];
		}
		return (await res.json()) as RawState[];
	} catch (err) {
		console.error('[HA] Error listing states:', (err as Error).message);
		return [];
	}
}

/**
 * Rende un template Jinja tramite l'API REST. Serve per leggere le label, che non
 * sono esposte da /api/states (vivono nell'entity registry).
 */
async function renderTemplate(template: string): Promise<string | null> {
	if (!HA_TOKEN) return null;
	try {
		const res = await fetch(`${HA_BASE_URL}/template`, {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ template }),
		});
		if (!res.ok) {
			// Home Assistant < 2024.4 non conosce label_entities(): non è un errore fatale,
			// si ripiega sull'elenco per device_class.
			console.warn(`[HA] Template render failed (${res.status})`);
			return null;
		}
		return await res.text();
	} catch (err) {
		console.error('[HA] Error rendering template:', (err as Error).message);
		return null;
	}
}

async function getLabeledEntityIds(label: string): Promise<string[] | null> {
	const rendered = await renderTemplate(`{{ label_entities('${label.replace(/'/g, "\\'")}') | list | to_json }}`);
	if (!rendered) return null;
	try {
		const parsed = JSON.parse(rendered.trim()) as unknown;
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((id): id is string => typeof id === 'string');
	} catch {
		console.warn('[HA] Unexpected label_entities output:', rendered.slice(0, 120));
		return null;
	}
}

function toOption(state: RawState): HaEntityOption {
	return {
		entityId: state.entity_id,
		name: (state.attributes?.friendly_name as string | undefined) || state.entity_id,
		deviceClass: state.attributes?.device_class as string | undefined,
		unit: state.attributes?.unit_of_measurement as string | undefined,
		state: state.state,
	};
}

let entityCache: { at: number; value: HaEntityList } | null = null;

/**
 * Entità proposte nella scelta dei sensori. Prima si prova l'etichetta
 * "metaplants"; se non esiste (o l'istanza è troppo vecchia per label_entities)
 * si ripiega su tutti i sensori con un device_class utile.
 */
export async function listSensorEntities(force = false): Promise<HaEntityList> {
	if (!isHaAvailable()) {
		return { available: false, labeled: false, label: METAPLANTS_LABEL, entities: [] };
	}
	if (!force && entityCache && Date.now() - entityCache.at < ENTITY_CACHE_MS) {
		return entityCache.value;
	}

	const [labeledIds, states] = await Promise.all([
		getLabeledEntityIds(METAPLANTS_LABEL),
		getAllStates(),
	]);

	const byId = new Map(states.map((s) => [s.entity_id, s]));
	let labeled = false;
	let entities: HaEntityOption[];

	if (labeledIds && labeledIds.length > 0) {
		labeled = true;
		entities = labeledIds.map((id) => {
			const state = byId.get(id);
			// L'entità è etichettata ma senza stato (non disponibile): la proponiamo comunque.
			return state ? toOption(state) : { entityId: id, name: id };
		});
	} else {
		entities = states
			.filter((s) => {
				if (!s.entity_id.startsWith('sensor.')) return false;
				const deviceClass = s.attributes?.device_class as string | undefined;
				// Con un device_class dichiarato ci si fida di quello: senza questo
				// filtro l'elenco si riempie di sensori batteria, che sono anch'essi in %.
				if (deviceClass) return RELEVANT_DEVICE_CLASSES.includes(deviceClass);
				const unit = s.attributes?.unit_of_measurement as string | undefined;
				return unit === '%' || unit === '°C' || unit === '°F';
			})
			.map(toOption);
	}

	entities.sort((a, b) => a.name.localeCompare(b.name));
	const value: HaEntityList = { available: true, labeled, label: METAPLANTS_LABEL, entities };
	entityCache = { at: Date.now(), value };
	console.log(`[HA] ${entities.length} entità disponibili per i sensori (label "${METAPLANTS_LABEL}": ${labeled ? 'sì' : 'no'})`);
	return value;
}
