import type { FastifyInstance } from 'fastify';
import type { createPremiumController } from '../controllers/premium.controller.js';

export function premiumRoutes(app: FastifyInstance, c: ReturnType<typeof createPremiumController>) {
  app.post('/api/premium/order', c.order);
  app.post('/api/premium/verify', c.verify);
  app.get('/api/premium/status', c.status);
}
