import type { FastifyRequest } from 'fastify';
import { VerifyBody } from '../schemas/premium.schema.js';
import type { PremiumService } from '../services/premium.service.js';

export function createPremiumController(premium: PremiumService) {
  return {
    order: () => premium.createOrder(),
    async verify(req: FastifyRequest) {
      const b = VerifyBody.parse(req.body ?? {});
      return premium.verifyAndIssue(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature);
    },
    status(req: FastifyRequest) {
      const exp = premium.validUntil(req.headers['x-premium-token'] as string | undefined);
      return { success: true, active: exp > 0, expiresAt: exp };
    },
  };
}
