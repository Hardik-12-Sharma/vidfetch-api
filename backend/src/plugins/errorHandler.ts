import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ApiError } from '../utils/apiError.js';

/** Every error leaves as { success:false, message } — the contract the existing frontend reads. */
export function registerErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ success: false, message: 'Not found.' }));
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ success: false, message: err.message });
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const missing = first?.code === 'invalid_type' && first.received === 'undefined';
      return reply.code(400).send({ success: false, message: missing ? `Missing parameter: ${first.path.join('.')}` : 'Invalid request.' });
    }
    if (typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ success: false, message: err.statusCode === 413 ? 'Request too large.' : 'Bad request.' });
    }
    req.log.error({ err: { message: err?.message, name: err?.name } }, 'unhandled error'); // no request URL/headers, no stack paths in the response
    return reply.code(500).send({ success: false, message: 'Something went wrong on the server.' });
  });
}
