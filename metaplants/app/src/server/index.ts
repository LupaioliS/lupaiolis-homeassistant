import 'dotenv/config';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import path from 'path';
import { plantRoutes } from './routes/plants';
import { connectMqtt, disconnectMqtt, publishAllPlants, publishPlant } from './mqtt';
import { store, UPLOADS_DIR, ensureUploadsDir } from './store';
import { addClient } from './events';
import { config } from './config';

import { startScheduler, stopScheduler } from './scheduler';
import { startSensorPolling, stopSensorPolling, setOnReadingsUpdated, migrateLegacySensorHistory } from './sensors';
import { loadHistory, startHistoryPersistence, stopHistoryPersistence } from './history';

const fastify = Fastify({ logger: true });

async function start() {
	await fastify.register(fastifyCors);

	// Multipart for image uploads (max 8 MB per file)
	await fastify.register(fastifyMultipart, {
		limits: { fileSize: 8 * 1024 * 1024, files: 1 },
	});

	// API routes
	await fastify.register(plantRoutes, { prefix: '/api' });

	// SSE endpoint for real-time updates
	fastify.get('/api/events', (request, reply) => {
		const raw = reply.raw;
		addClient(raw);
		// Prevent Fastify from closing the response
		reply.hijack();
	});

	// Locale endpoint for client
	const serverLocale = config.lang;
	fastify.get('/api/locale', async () => {
		return { locale: serverLocale };
	});

	// Serve uploaded images from the persistent data directory.
	// I nomi file sono UUID e il contenuto non cambia mai: si può cacheare per sempre,
	// così il telefono non riscarica le foto ad ogni apertura della UI.
	ensureUploadsDir();
	await fastify.register(fastifyStatic, {
		root: UPLOADS_DIR,
		prefix: '/uploads/',
		decorateReply: false,
		maxAge: 31536000_000,
		immutable: true,
	});

	// Serve React static files
	const clientPath = path.resolve(__dirname, '../../dist/client');
	await fastify.register(fastifyStatic, {
		root: clientPath,
		wildcard: false,
	});

	// SPA fallback
	fastify.setNotFoundHandler((_req, reply) => {
		reply.sendFile('index.html');
	});

	// Storico letture: serve al modello di previsione ed evita di riscrivere
	// plants.json ad ogni poll dei sensori.
	loadHistory();
	migrateLegacySensorHistory();
	startHistoryPersistence();

	// Connect MQTT and publish all plants
	try {
		await connectMqtt();
		publishAllPlants(store.getPlants());
		startScheduler();
		// Republish a plant's MQTT state as soon as a fresh sensor reading comes in,
		// so the frontend (SSE) and MQTT reflect the same data at the same time
		// instead of waiting for the next scheduler tick.
		setOnReadingsUpdated(publishPlant);
	} catch (err) {
		console.warn('[MQTT] Failed to connect, running without MQTT:', (err as Error).message);
	}

	// HA sensor polling is independent of MQTT — must start even if MQTT is unreachable.
	startSensorPolling();

	const port = Number(process.env.PORT) || 3000;
	await fastify.listen({ port, host: '0.0.0.0' });
	console.log(`MetaPlants server running on port ${port}`);
}

async function shutdown() {
	stopScheduler();
	stopSensorPolling();
	stopHistoryPersistence(); // scrive su disco le letture non ancora salvate
	await disconnectMqtt();
	process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown); // utile in sviluppo con Ctrl-C


start().catch((err) => {
	fastify.log.error(err);
	process.exit(1);
});
