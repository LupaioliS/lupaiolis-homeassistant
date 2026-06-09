import type { Plant, PlantAction, HealthIssue, ProductUsage } from '../shared/types';

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
	logAction: (plantId: string, type: 'water' | 'fertilize' | 'repot' | 'prune', notes?: string) =>
		request<PlantAction>(`/plants/${encodeURIComponent(plantId)}/actions`, {
			method: 'POST',
			body: JSON.stringify({ type, notes }),
		}),
	getActions: (plantId: string) =>
		request<PlantAction[]>(`/plants/${encodeURIComponent(plantId)}/actions`),
	addHealthIssue: (plantId: string, data: { type: string; name: string; detectedDate: string; notes?: string; imageUrl?: string }) =>
		request<HealthIssue>(`/plants/${encodeURIComponent(plantId)}/health`, {
			method: 'POST',
			body: JSON.stringify(data),
		}),
	resolveHealthIssue: (plantId: string, issueId: string, treatment?: string) =>
		request<HealthIssue>(`/plants/${encodeURIComponent(plantId)}/health/${encodeURIComponent(issueId)}/resolve`, {
			method: 'PUT',
			body: JSON.stringify({ treatment }),
		}),
	addProductUsage: (plantId: string, data: { productName: string; date: string; reason?: string; notes?: string }) =>
		request<ProductUsage>(`/plants/${encodeURIComponent(plantId)}/products`, {
			method: 'POST',
			body: JSON.stringify(data),
		}),
	uploadImage: async (file: File): Promise<string> => {
		const form = new FormData();
		form.append('file', file);
		const res = await fetch(`${BASE}/upload`, { method: 'POST', body: form });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as { url: string };
		return data.url;
	},
	syncMqtt: () => request<{ success: boolean }>('/mqtt/sync', { method: 'POST' }),
};
