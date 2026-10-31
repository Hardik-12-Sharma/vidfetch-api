import { describe, expect, it } from 'vitest';
import { JobService } from '../src/services/jobs.service.js';
import { progressTracker, type DownloadProgress } from '../src/services/ytdlp.service.js';

const file = { path: '/tmp/x/media.mp4', dir: '/tmp/x', ext: 'mp4' };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('progressTracker', () => {
  it('maps video to 0-90% and audio to 90-99%, then reports merging', () => {
    const got: DownloadProgress[] = [];
    const t = progressTracker(2, (p) => got.push(p))!;
    ['VFPROG 500 1000 NA', 'VFPROG 1000 1000 NA', 'VFPROG 100 200 NA', 'VFPROG 200 200 NA', '[Merger] Merging formats into "x.mp4"'].forEach(t);
    expect(got.map((g) => g.percent)).toEqual([45, 90, 94.5, 99, 99]);
    expect(got.at(-1)!.status).toBe('merging');
  });
  it('uses the estimate when the total is unknown, and ignores unrelated lines', () => {
    const got: DownloadProgress[] = [];
    const t = progressTracker(1, (p) => got.push(p))!;
    ['[youtube] noise', 'VFPROG 50 NA 100'].forEach(t);
    expect(got).toEqual([{ status: 'downloading', percent: 49.5 }]);
  });
  it('returns nothing when nobody listens', () => expect(progressTracker(1)).toBeUndefined());
});

describe('JobService', () => {
  it('runs a job, exposes progress, serves the file and cleans it up later', async () => {
    const cleaned: string[] = [];
    const jobs = new JobService(async (f) => { cleaned.push(f.path); });
    const id = jobs.start(async (report) => { report({ status: 'downloading', percent: 40 }); report({ percent: 10 }); await tick(); return file; });
    expect(jobs.view(id)).toEqual({ status: 'downloading', percent: 40 });   // percent never goes backwards
    await tick(60);
    expect(jobs.view(id)).toEqual({ status: 'ready', percent: 100 });
    expect(jobs.file(id)).toEqual(file);
    jobs.served(id);
    await jobs.sweep(Date.now() + 3 * 60_000);
    expect(cleaned).toEqual([file.path]);
    expect(() => jobs.view(id)).toThrow('expired');
    await jobs.close();
  });
  it('keeps the error message of a failed job and rejects unknown ids', async () => {
    const jobs = new JobService(async () => undefined);
    const id = jobs.start(async () => { throw new Error('boom'); });
    await tick();
    expect(jobs.view(id)).toMatchObject({ status: 'error', message: 'Download failed. Please try again.' });
    expect(() => jobs.file(id)).toThrow();
    expect(() => jobs.view('../etc/passwd')).toThrow('expired');
    await jobs.close();
  });
  it('refuses new jobs when full', async () => {
    const jobs = new JobService(async () => undefined, 60_000, 1);
    jobs.start(() => new Promise(() => undefined));
    expect(() => jobs.start(async () => file)).toThrow('busy');
    await jobs.close();
  });
});
