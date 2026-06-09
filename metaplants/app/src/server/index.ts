import 'dotenv/config';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'path';
import { plantRoutes } from './routes/plants';
import { connectMqtt, disconnectMqtt, publishAllPlants } from './mqtt';
import { store } from './store';
import { addClient } from './events';

const fastify = Fastify({ logger: true });

async function start() {
	await fastify.register(fastifyCors);

	// API routes
	await fastify.register(plantRoutes, { prefix: '/api' });

	// SSE endpoint for real-time updates
	fastify.get('/api/events', (request, reply) => {
		const raw = reply.raw;
		addClient(raw);
		// Prevent Fastify from closing the response
		reply.hijack();
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

	// Connect MQTT and publish all plants
	try {
		await connectMqtt();
		publishAllPlants(store.getPlants());
	} catch (err) {
		console.warn('[MQTT] Failed to connect, running without MQTT:', (err as Error).message);
	}

	const port = Number(process.env.PORT) || 3000;
	await fastify.listen({ port, host: '0.0.0.0' });
	console.log(`MetaPlants server running on port ${port}`);
}

process.on('SIGTERM', async () => {
	await disconnectMqtt();
	process.exit(0);
});

start().catch((err) => {
	fastify.log.error(err);
	process.exit(1);
});
