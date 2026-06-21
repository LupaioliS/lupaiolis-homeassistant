import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { SeasonalSchedule, Season, PlantSensors } from '../../shared/types';
import { store, UPLOADS_DIR, ensureUploadsDir } from '../store';
import { publishPlant, publishAllPlants, removePlant, republishPlant } from '../mqtt';
import { broadcast } from '../events';
import { getAllReadings, refreshPlantReadings } from '../sensors';

const ALLOWED_IMAGE_EXT: Record<string, string> = {
	'image/jpeg': '.jpg',
	'image/png': '.png',
	'image/webp': '.webp',
	'image/gif': '.gif',
};

function getCurrentSeason(): Season {
	const month = new Date().getMonth();
	if (month >= 2 && month <= 4) return 'spring';
	if (month >= 5 && month <= 7) return 'summer';
	if (month >= 8 && month <= 10) return 'autumn';
	return 'winter';
}

function getSeasonalInterval(schedule: SeasonalSchedule | undefined, season: Season, fallback: number): number {
	const value = schedule?.[season];
	if (typeof value === 'number' && value > 0) return value;
	return fallback;
}

export const plantRoutes: FastifyPluginAsync = async (fastify) => {
	// Upload an image, returns its public URL
	fastify.post('/upload', async (request, reply) => {
		const file = await request.file();
		if (!file) return reply.status(400).send({ error: 'No file uploaded' });
		const ext = ALLOWED_IMAGE_EXT[file.mimetype];
		if (!ext) return reply.status(415).send({ error: 'Unsupported image type' });
		ensureUploadsDir();
		const filename = `${randomUUID()}${ext}`;
		const dest = path.join(UPLOADS_DIR, filename);
		await pipeline(file.file, fs.createWriteStream(dest));
		if (file.file.truncated) {
			fs.unlinkSync(dest);
			return reply.status(413).send({ error: 'File too large' });
		}
		return { url: `uploads/${filename}` };
	});

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
	fastify.post<{ 
		Body: { 
			name: string; 
			species: string; 
			location: string; 
			wateringSchedule?: SeasonalSchedule; 
			fertilizingSchedule?: SeasonalSchedule; 
			wateringIntervalDays?: number; 
			fertilizingIntervalDays?: number; 
			imageUrl?: string; 
			purchaseDate?: string; 
			lastRepotted?: string; 
			lastPruned?: string; 
			recommendedFertilizer?: string; 
			notes?: string;
			sensors?: PlantSensors;
		} 
	}>('/plants', async (request) => {
		const {
			name,
			species,
			location,
			wateringSchedule,
			fertilizingSchedule,
			wateringIntervalDays,
			fertilizingIntervalDays,
			imageUrl,
			purchaseDate,
			lastRepotted,
			lastPruned,
			recommendedFertilizer,
			notes,
			sensors
		} = request.body;

		const season = getCurrentSeason();
		const computedWateringInterval = getSeasonalInterval(wateringSchedule, season, wateringIntervalDays ?? 3);
		const computedFertilizingInterval = getSeasonalInterval(fertilizingSchedule, season, fertilizingIntervalDays ?? 14);

		const plant = store.createPlant({
			name,
			species,
			location,
			wateringSchedule,
			fertilizingSchedule,
			wateringIntervalDays: computedWateringInterval,
			fertilizingIntervalDays: computedFertilizingInterval,
			imageUrl,
			purchaseDate,
			lastRepotted,
			lastPruned,
			recommendedFertilizer,
			notes,
			sensors
		});
		publishPlant(plant);
		broadcast({ type: 'plant-created', plant });
		void refreshPlantReadings(plant);
		return plant;
	});

	// Update plant
	fastify.put<{ 
		Params: { 
			id: string 
		}; 
		Body: Partial<{ 
			name: string; 
			species: string; 
			location: string; 
			wateringSchedule: SeasonalSchedule; 
			fertilizingSchedule: SeasonalSchedule; 
			wateringIntervalDays: number; 
			fertilizingIntervalDays: number; 
			imageUrl: string; 
			purchaseDate: string; 
			lastRepotted: string; 
			lastPruned: string; 
			recommendedFertilizer: string; 
			notes: string;
			sensors: PlantSensors;
		}> 
	}>('/plants/:id', async (request, reply) => {
		const season = getCurrentSeason();
		const body = { ...request.body };
		if (body.wateringSchedule) {
			body.wateringIntervalDays = getSeasonalInterval(body.wateringSchedule, season, body.wateringIntervalDays ?? 3);
		}
		if (body.fertilizingSchedule) {
			body.fertilizingIntervalDays = getSeasonalInterval(body.fertilizingSchedule, season, body.fertilizingIntervalDays ?? 14);
		}

		const plant = store.updatePlant(request.params.id, body);
		if (!plant) return reply.status(404).send({ error: 'Plant not found' });
		republishPlant(plant);
		broadcast({ type: 'plant-updated', plant });
		void refreshPlantReadings(plant);
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
	fastify.post<{ Params: { id: string }; Body: { type: 'water' | 'fertilize' | 'repot' | 'prune'; notes?: string; amountMl?: number; amountGrams?: number; potSizeCm?: number } }>('/plants/:id/actions', async (request, reply) => {
		const { type, notes, amountMl, amountGrams, potSizeCm } = request.body;
		const action = store.addAction(request.params.id, type, { notes, amountMl, amountGrams, potSizeCm });
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
	fastify.post<{ Params: { id: string }; Body: { type: 'pest' | 'disease' | 'fungus'; name: string; detectedDate: string; notes?: string; imageUrl?: string } }>('/plants/:id/health', async (request, reply) => {
		const { type, name, detectedDate, notes, imageUrl } = request.body;
		const issue = store.addHealthIssue(request.params.id, { type, name: name as any, detectedDate, notes, imageUrl });
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

	fastify.get('/readings', async () => getAllReadings());
};
