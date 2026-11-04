import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { answerCard, applyCard, dismissCard, getAssistantState, runAssistant, undoCard } from '../assistant';

function fail(reply: FastifyReply, err: unknown) {
	const message = (err as Error).message;
	if (message === 'NOT_FOUND') return reply.status(404).send({ error: 'Card not found' });
	if (message === 'BAD_REQUEST') return reply.status(400).send({ error: 'Invalid request' });
	if (message === 'TOO_SOON') return reply.status(429).send({ error: 'TOO_SOON' });
	return reply.status(500).send({ error: message });
}

export const assistantRoutes: FastifyPluginAsync = async (fastify) => {
	fastify.get('/assistant', async () => getAssistantState());

	fastify.post('/assistant/run', async (_request, reply) => {
		try {
			return await runAssistant('manual');
		} catch (err) {
			return fail(reply, err);
		}
	});

	fastify.post<{ Params: { id: string }; Body: { answer: string } }>('/assistant/cards/:id/answer', async (request, reply) => {
		try {
			return answerCard(request.params.id, request.body?.answer);
		} catch (err) {
			return fail(reply, err);
		}
	});

	for (const [verb, handler] of [['apply', applyCard], ['undo', undoCard], ['dismiss', dismissCard]] as const) {
		fastify.post<{ Params: { id: string } }>(`/assistant/cards/:id/${verb}`, async (request, reply) => {
			try {
				return handler(request.params.id);
			} catch (err) {
				return fail(reply, err);
			}
		});
	}
};
