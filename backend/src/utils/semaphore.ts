import { ApiError } from './apiError.js';

/** Counting semaphore with a bounded wait (port of Semaphore.tryAcquire(5, SECONDS)). */
export class Semaphore {
  private waiters: Array<(ok: boolean) => void> = [];
  constructor(private free: number) {}
  tryAcquire(timeoutMs: number): Promise<boolean> {
    if (this.free > 0) { this.free--; return Promise.resolve(true); }
    return new Promise((resolve) => {
      const w = (ok: boolean) => { clearTimeout(t); resolve(ok); };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(false); }, timeoutMs);
      this.waiters.push(w);
    });
  }
  release() {
    const next = this.waiters.shift();
    if (next) next(true); else this.free++;
  }
}

/** Runs tasks with limited concurrency and a bounded queue (port of the info ThreadPoolExecutor). */
export class BoundedQueue {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private concurrency: number, private maxQueued: number) {}
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running++;
        task().then(resolve, reject).finally(() => { this.running--; this.queue.shift()?.(); });
      };
      if (this.running < this.concurrency) return start();
      if (this.queue.length >= this.maxQueued) return reject(new ApiError(503, 'Server is busy. Please try again in a minute.'));
      this.queue.push(start);
    });
  }
}
