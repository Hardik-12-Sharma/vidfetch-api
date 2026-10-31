import { describe, expect, it } from 'vitest';
import { bucketFor, FixedWindowLimiter } from '../src/plugins/rateLimit.js';
import { BoundedQueue, Semaphore } from '../src/utils/semaphore.js';

describe('FixedWindowLimiter', () => {
  it('allows `limit` hits per window then blocks, per key', () => {
    let t = 1000;
    const l = new FixedWindowLimiter(60_000, () => t);
    for (let i = 0; i < 5; i++) expect(l.hit('download:1.1.1.1', 5)).toBe(true);
    expect(l.hit('download:1.1.1.1', 5)).toBe(false);
    expect(l.hit('download:2.2.2.2', 5)).toBe(true);   // other IP unaffected
    expect(l.hit('info:1.1.1.1', 5)).toBe(true);       // other bucket unaffected
  });
  it('resets after the window', () => {
    let t = 0;
    const l = new FixedWindowLimiter(60_000, () => t);
    l.hit('k', 1); expect(l.hit('k', 1)).toBe(false);
    t = 60_000; expect(l.hit('k', 1)).toBe(true);
  });
});

describe('bucketFor', () => {
  it('maps paths like the Java interceptor', () => {
    expect(bucketFor('/api/media/info')).toBe('info');
    expect(bucketFor('/api/media/download')).toBe('download');
    expect(bucketFor('/api/premium/order')).toBe('order');
    expect(bucketFor('/api/premium/verify')).toBe('order');
    expect(bucketFor('/api/premium/status')).toBeNull();
    expect(bucketFor('/api/health')).toBeNull();
  });
});

describe('Semaphore / BoundedQueue', () => {
  it('semaphore times out when full and hands over on release', async () => {
    const s = new Semaphore(1);
    expect(await s.tryAcquire(10)).toBe(true);
    expect(await s.tryAcquire(20)).toBe(false);
    const waiting = s.tryAcquire(500);
    s.release();
    expect(await waiting).toBe(true);
  });
  it('queue rejects with 503 when saturated', async () => {
    const q = new BoundedQueue(1, 1);
    const hold = new Promise<void>((r) => setTimeout(r, 50));
    const a = q.run(() => hold), b = q.run(async () => 'b');
    await expect(q.run(async () => 'c')).rejects.toThrow(/busy/);
    await a; expect(await b).toBe('b');
  });
});
