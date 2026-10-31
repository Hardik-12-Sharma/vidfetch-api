import { randomBytes } from 'node:crypto';
import { ApiError } from '../utils/apiError.js';
import type { DownloadedFile, ProgressReporter } from './ytdlp.service.js';

export type JobStatus = 'preparing' | 'downloading' | 'merging' | 'ready' | 'error';
export interface JobView { status: JobStatus; percent: number; message?: string }

interface Job extends JobView { file?: DownloadedFile; expires: number; ac: AbortController }

const ID_RE = /^[a-f0-9]{32}$/;
const NEVER = Number.MAX_SAFE_INTEGER;

/**
 * In-memory download jobs: the browser starts a job, polls its progress, then fetches the finished file.
 * Files are removed a few minutes after they were served (or after the TTL if nobody fetched them).
 */
export class JobService {
  private jobs = new Map<string, Job>();
  private timer: NodeJS.Timeout;

  constructor(private cleanup: (f: DownloadedFile) => Promise<unknown>, private ttlMs = 10 * 60_000, private maxJobs = 100) {
    this.timer = setInterval(() => void this.sweep(), 30_000);
    this.timer.unref();
  }

  start(run: (report: ProgressReporter, signal: AbortSignal) => Promise<DownloadedFile>): string {
    if (this.jobs.size >= this.maxJobs) throw new ApiError(503, 'Server is busy. Please try again in a minute.');
    const id = randomBytes(16).toString('hex');
    const job: Job = { status: 'preparing', percent: 0, expires: Date.now() + this.ttlMs, ac: new AbortController() };
    this.jobs.set(id, job);

    const report: ProgressReporter = (p) => {
      if (job.status === 'ready' || job.status === 'error') return;
      if (p.status) job.status = p.status;
      if (typeof p.percent === 'number' && Number.isFinite(p.percent)) job.percent = Math.max(job.percent, Math.min(99, Math.round(p.percent)));
    };
    run(report, job.ac.signal).then(
      async (file) => {
        if (this.jobs.get(id) !== job) { await this.cleanup(file); return; }   // swept while it was running
        job.file = file; job.status = 'ready'; job.percent = 100; job.expires = Date.now() + this.ttlMs;
      },
      (e: unknown) => {
        job.status = 'error';
        job.message = e instanceof ApiError ? e.message : 'Download failed. Please try again.';
        job.expires = Date.now() + 60_000;
      },
    );
    return id;
  }

  view(id: string): JobView {
    const job = this.find(id);
    return { status: job.status, percent: job.percent, ...(job.message ? { message: job.message } : {}) };
  }

  /** Returns the finished file and keeps it alive while it is being sent. Call `served` when the response closes. */
  file(id: string): DownloadedFile {
    const job = this.find(id);
    if (job.status === 'error') throw new ApiError(502, job.message ?? 'Download failed. Please try again.');
    if (job.status !== 'ready' || !job.file) throw new ApiError(409, 'The file is not ready yet.');
    job.expires = NEVER;
    return job.file;
  }

  /** After the response ended (finished or aborted): keep the file 2 more minutes for a retry, then delete it. */
  served(id: string) {
    const job = this.jobs.get(id);
    if (job) job.expires = Date.now() + 2 * 60_000;
  }

  private find(id: string): Job {
    const job = ID_RE.test(id) ? this.jobs.get(id) : undefined;
    if (!job) throw new ApiError(404, 'This download expired. Please try again.');
    return job;
  }

  async sweep(now = Date.now()) {
    for (const [id, job] of this.jobs) {
      if (job.expires > now) continue;
      this.jobs.delete(id);
      job.ac.abort();
      if (job.file) await this.cleanup(job.file);
    }
  }

  async close() {
    clearInterval(this.timer);
    const all = [...this.jobs.values()];
    this.jobs.clear();
    for (const job of all) { job.ac.abort(); if (job.file) await this.cleanup(job.file); }
  }
}
