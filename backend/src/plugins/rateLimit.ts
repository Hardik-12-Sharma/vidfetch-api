import type { FastifyInstance } from 'fastify';

/** Fixed 1-minute window per (bucket, IP) — same algorithm as the Java RateLimitInterceptor. */
export class FixedWindowLimiter {
  private w = new Map<string, { start: number; count: number }>();
  constructor(private windowMs = 60_000, private now: () => number = Date.now) {}
  /** Returns true if the request is allowed. */
  hit(key: string, limit: number): boolean {
    const t = this.now();
    if (this.w.size > 10_000) for (const [k, v] of this.w) if (t - v.start >= this.windowMs) this.w.delete(k);
    const cur = this.w.get(key);
    if (!cur || t - cur.start >= this.windowMs) { this.w.set(key, { start: t, count: 1 }); return limit >= 1; }
    cur.count++;
    return cur.count <= limit;
  }
}

export interface Limits { info: number; download: number; order: number }

export function bucketFor(pathname: string): 'info' | 'download' | 'order' | null {
  if (pathname.startsWith('/api/media/info')) return 'info';
  if (pathname.startsWith('/api/media/download') || pathname.startsWith('/api/media/prepare')) return 'download';   // progress/file polling is not limited
  if (pathname.startsWith('/api/premium/order') || pathname.startsWith('/api/premium/verify')) return 'order';
  return null;
}

export function registerRateLimit(app: FastifyInstance, limits: Limits, limiter = new FixedWindowLimiter()) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const bucket = bucketFor(req.url.split('?')[0]!);
    if (!bucket) return;
    if (!limiter.hit(`${bucket}:${req.ip}`, limits[bucket])) {
      return reply.code(429).header('Retry-After', '60').send({ success: false, message: 'Too many requests. Please try again in a minute.' });
    }
  });
}
