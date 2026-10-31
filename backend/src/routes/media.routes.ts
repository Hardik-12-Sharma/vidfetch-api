import type { FastifyInstance } from 'fastify';
import type { createMediaController } from '../controllers/media.controller.js';

export function mediaRoutes(app: FastifyInstance, c: ReturnType<typeof createMediaController>) {
  app.get('/api/media/info', c.info);   // original accepted both verbs
  app.post('/api/media/info', c.info);
  app.get('/api/media/download', c.download);
  app.get('/api/media/prepare', c.prepare);          // starts a background download, returns { jobId }
  app.get('/api/media/progress/:id', c.progress);    // { status, percent }
  app.get('/api/media/file/:id', c.file);            // the finished file
}
