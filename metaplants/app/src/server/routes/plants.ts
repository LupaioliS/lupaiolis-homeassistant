import type { FastifyPluginAsync } from 'fastify';
import { store } from '../store';
import { publishPlant, publishAllPlants, removePlant, republishPlant } from '../mqtt';
import { broadcast } from '../events';

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
		broadcast({ type: 'plant-created', plant });
		return plant;
	});

	// Update plant
	fastify.put<{ Params: { id: string }; Body: Partial<{ name: string; species: string; location: string; wateringIntervalDays: number; fertilizingIntervalDays: number; imageUrl: string; notes: string }> }>('/plants/:id', async (request, reply) => {
		const plant = store.updatePlant(request.params.id, request.body);
		if (!plant) return reply.status(404).send({ error: 'Plant not found' });
		republishPlant(plant);
		broadcast({ type: 'plant-updated', plant });
		return plant;
	});

	// Delete plant
	fastify.delete<{ Params: { id: string } }>('/plants/:id', async (request, reply) => {
		const deleted = store.deletePlant(request.params.id);
		if (!deleted) return reply.status(404).send({ error: 'Plant not found' });
		removePlant(deleted);
		broadcast({ type: 'plant-deleted', plantId: deleted.id });
		return { success: true };
	});

	// Log action (water/fertilize/repot/prune)
	fastify.post<{ Params: { id: string }; Body: { type: 'water' | 'fertilize' | 'repot' | 'prune'; notes?: string } }>('/plants/:id/actions', async (request, reply) => {
		const { type, notes } = request.body;
		const action = store.addAction(request.params.id, type, notes);
		if (!action) return reply.status(404).send({ error: 'Plant not found' });
		const plant = store.getPlant(request.params.id);
		if (plant) {
			publishPlant(plant);
			broadcast({ type: 'plant-updated', plant });
		}
		return action;
	});

	// Get actions for a plant
	fastify.get<{ Params: { id: string } }>('/plants/:id/actions', async (request) => {
		return store.getActions(request.params.id);
	});

	// Add health issue
	fastify.post<{ Params: { id: string }; Body: { type: 'pest' | 'disease' | 'fungus'; name: string; detectedDate: string; notes?: string } }>('/plants/:id/health', async (request, reply) => {
		const { type, name, detectedDate, notes } = request.body;
		const issue = store.addHealthIssue(request.params.id, { type, name: name as any, detectedDate, notes });
		if (!issue) return reply.status(404).send({ error: 'Plant not found' });
		const plant = store.getPlant(request.params.id);
		if (plant) {
			publishPlant(plant);
			broadcast({ type: 'plant-updated', plant });
		}
		return issue;
	});

	// Resolve health issue
	fastify.put<{ Params: { id: string; issueId: string }; Body: { treatment?: string } }>('/plants/:id/health/:issueId/resolve', async (request, reply) => {
		const issue = store.resolveHealthIssue(request.params.id, request.params.issueId, request.body.treatment);
		if (!issue) return reply.status(404).send({ error: 'Issue not found' });
		const plant = store.getPlant(request.params.id);
		if (plant) {
			publishPlant(plant);
			broadcast({ type: 'plant-updated', plant });
		}
		return issue;
	});

	// Add product usage
	fastify.post<{ Params: { id: string }; Body: { productName: string; date: string; reason?: string; notes?: string } }>('/plants/:id/products', async (request, reply) => {
		const { productName, date, reason, notes } = request.body;
		const usage = store.addProductUsage(request.params.id, { productName, date, reason, notes });
		if (!usage) return reply.status(404).send({ error: 'Plant not found' });
		const plant = store.getPlant(request.params.id);
		if (plant) broadcast({ type: 'plant-updated', plant });
		return usage;
	});

	// Force republish all plants to MQTT
	fastify.post('/mqtt/sync', async () => {
		publishAllPlants(store.getPlants());
		return { success: true };
	});
};
