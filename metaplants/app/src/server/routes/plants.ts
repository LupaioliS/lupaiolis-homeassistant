import type { FastifyPluginAsync } from 'fastify';
import { store } from '../store';
import { publishPlant, publishAllPlants, removePlant } from '../mqtt';

export const plantRoutes: FastifyPluginAsync = async (fastify) => {
	// Get all plants
	fastify.get('/plants', async () => {
		return store.getPlants();
	});

	// Get single plant
	fastify.get<{ Params: { id: string } }>('/plants/:id', async (request, reply) => {
		const plant = store.getPlant(request.params.id);
		if (!plant) return reply.status(404).send({ error: 'Plant not found' });
		return plant;
	});

	// Create plant
	fastify.post<{ Body: { name: string; species: string; location: string; wateringIntervalDays: number; fertilizingIntervalDays: number; imageUrl?: string; notes?: string } }>('/plants', async (request) => {
		const { name, species, location, wateringIntervalDays, fertilizingIntervalDays, imageUrl, notes } = request.body;
		const plant = store.createPlant({ name, species, location, wateringIntervalDays, fertilizingIntervalDays, imageUrl, notes });
		publishPlant(plant);
		return plant;
	});

	// Update plant
	fastify.put<{ Params: { id: string }; Body: Partial<{ name: string; species: string; location: string; wateringIntervalDays: number; fertilizingIntervalDays: number; imageUrl: string; notes: string }> }>('/plants/:id', async (request, reply) => {
		const plant = store.updatePlant(request.params.id, request.body);
		if (!plant) return reply.status(404).send({ error: 'Plant not found' });
		publishPlant(plant);
		return plant;
	});

	// Delete plant
	fastify.delete<{ Params: { id: string } }>('/plants/:id', async (request, reply) => {
		const deleted = store.deletePlant(request.params.id);
		if (!deleted) return reply.status(404).send({ error: 'Plant not found' });
		removePlant(deleted);
		return { success: true };
	});

	// Log action (water/fertilize)
	fastify.post<{ Params: { id: string }; Body: { type: 'water' | 'fertilize'; notes?: string } }>('/plants/:id/actions', async (request, reply) => {
		const { type, notes } = request.body;
		const action = store.addAction(request.params.id, type, notes);
		if (!action) return reply.status(404).send({ error: 'Plant not found' });
		const plant = store.getPlant(request.params.id);
		if (plant) publishPlant(plant);
		return action;
	});

	// Get actions for a plant
	fastify.get<{ Params: { id: string } }>('/plants/:id/actions', async (request) => {
		return store.getActions(request.params.id);
	});

	// Force republish all plants to MQTT
	fastify.post('/mqtt/sync', async () => {
		publishAllPlants(store.getPlants());
		return { success: true };
	});
};
