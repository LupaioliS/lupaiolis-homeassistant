import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { SeasonalSchedule, PlantSensors } from '../../shared/types';
import { getCurrentSeason, getIntervalForSeason } from '../../shared/schedule';
import { store, UPLOADS_DIR, ensureUploadsDir } from '../store';
import { publishPlant, publishAllPlants, removePlant, republishPlant } from '../mqtt';
import { broadcast } from '../events';
import { getAllReadings, getReadings, refreshPlantReadings, refreshPrediction } from '../sensors';
import { listSensorEntities } from '../homeassistant';
import { dropPlantHistory } from '../history';

const ALLOWED_IMAGE_EXT: Record<string, string> = {
	'image/jpeg': '.jpg',
	'image/png': '.png',
	'image/webp': '.webp',
	'image/gif': '.gif',
};

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
			nickname?: string;
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
			nickname,
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
		const computedWateringInterval = getIntervalForSeason(wateringSchedule, season, wateringIntervalDays ?? 3);
		const computedFertilizingInterval = getIntervalForSeason(fertilizingSchedule, season, fertilizingIntervalDays ?? 14);

		const plant = store.createPlant({
			name,
			nickname,
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
			nickname: string;
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
			body.wateringIntervalDays = getIntervalForSeason(body.wateringSchedule, season, body.wateringIntervalDays ?? 3);
		}
		if (body.fertilizingSchedule) {
			body.fertilizingIntervalDays = getIntervalForSeason(body.fertilizingSchedule, season, body.fertilizingIntervalDays ?? 14);
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
		dropPlantHistory(deleted.id);
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
			// Un'irrigazione appena registrata sposta sia il ciclo medio che il punto
			// di partenza della curva: la stima va rifatta subito, non al prossimo poll.
			if (type === 'water') refreshPrediction(plant);
		}
		return action;
	});

	// Get actions for a plant
	fastify.get<{ Params: { id: string } }>('/plants/:id/actions', async (request) => {
		return store.getActions(request.params.id);
	});

	// Tutte le azioni in una richiesta sola: il client ne ha bisogno per ogni scheda
	// e su rete mobile N richieste separate si sentono tutte.
	fastify.get('/actions', async () => store.getAllActions());

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

	// Entità di Home Assistant proponibili come sensori (etichetta "metaplants",
	// con fallback su tutti i sensori compatibili se l'etichetta non esiste).
	fastify.get<{ Querystring: { refresh?: string } }>('/ha/entities', async (request) => {
		return listSensorEntities(request.query.refresh === '1');
	});

	// Acknowledge a pending soil-jump prompt (user confirmed or skipped)
	fastify.post<{ Params: { id: string } }>('/plants/:id/ack-soil-jump', async (request, reply) => {
		const plant = store.getPlant(request.params.id);
		if (!plant) return reply.status(404).send({ error: 'Plant not found' });
		if (!plant.sensors) return reply.status(400).send({ error: 'No sensors configured' });
		// Re-baseline lastSoilHumidity to the current reading e fa ripartire da adesso
		// il periodo di calma: il terreno resta bagnato per ore anche quando l'utente
		// risponde "no", e senza questo verrebbe segnalato lo stesso salto ad ogni poll.
		const currentSoil = getReadings(plant.id)?.soilHumidity;
		const updated = store.updatePlant(plant.id, {
			sensors: {
				...plant.sensors,
				soilJumpPendingAck: false,
				lastSoilJumpAt: new Date().toISOString(),
				...(currentSoil != null ? { lastSoilHumidity: currentSoil } : {}),
			},
		});
		if (!updated) return reply.status(404).send({ error: 'Plant not found' });
		broadcast({ type: 'plant-updated', plant: updated });
		return { success: true };
	});
};
