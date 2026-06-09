import type { RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'http';

type SSEClient = ServerResponse<IncomingMessage>;

const clients = new Set<SSEClient>();

export function addClient(res: SSEClient) {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.write(':\n\n'); // comment to establish connection
	clients.add(res);

	res.on('close', () => {
		clients.delete(res);
	});
}

export function broadcast(data: unknown) {
	const payload = `data: ${JSON.stringify(data)}\n\n`;
	for (const client of clients) {
		client.write(payload);
	}
}
