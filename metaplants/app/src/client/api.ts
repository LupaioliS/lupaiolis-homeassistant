import type { Plant, PlantAction } from '../shared/types';

const BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${url}`, {
		headers: { 'Content-Type': 'application/json' },
		...options,
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

export const api = {
	getPlants: () => request<Plant[]>('/plants'),
	getPlant: (id: string) => request<Plant>(`/plants/${encodeURIComponent(id)}`),
	createPlant: (data: Omit<Plant, 'id' | 'createdAt'>) =>
		request<Plant>('/plants', { method: 'POST', body: JSON.stringify(data) }),
	updatePlant: (id: string, data: Partial<Plant>) =>
		request<Plant>(`/plants/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
	deletePlant: (id: string) =>
		request<{ success: boolean }>(`/plants/${encodeURIComponent(id)}`, { method: 'DELETE' }),
	logAction: (plantId: string, type: 'water' | 'fertilize', notes?: string) =>
		request<PlantAction>(`/plants/${encodeURIComponent(plantId)}/actions`, {
			method: 'POST',
			body: JSON.stringify({ type, notes }),
		}),
	getActions: (plantId: string) =>
		request<PlantAction[]>(`/plants/${encodeURIComponent(plantId)}/actions`),
	syncMqtt: () => request<{ success: boolean }>('/mqtt/sync', { method: 'POST' }),
};
