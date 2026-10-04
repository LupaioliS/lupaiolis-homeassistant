import type { RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'http';

type SSEClient = ServerResponse<IncomingMessage>;

const clients = new Set<SSEClient>();
const HEARTBEAT_MS = 20_000;

// Senza un ping periodico, un proxy intermedio (es. l'ingress di Home Assistant) può
// chiudere silenziosamente una connessione SSE idle, lasciando il browser convinto di
// essere ancora connesso finché non tenta una scrittura — risultato: frontend bloccato
// su dati stantii finché l'utente non ricarica la pagina a mano.
// È un evento vero e non un commento SSE (`:`), che il browser scarta senza dirlo
// alla pagina: solo così il client può accorgersi che i ping hanno smesso di
// arrivare — tipico sul telefono, dove la connessione muore in background senza
// che EventSource se ne renda conto.
const heartbeat = setInterval(() => broadcast({ type: 'ping' }), HEARTBEAT_MS);
heartbeat.unref();

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
