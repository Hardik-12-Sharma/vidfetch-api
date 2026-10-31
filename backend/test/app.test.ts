import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { PremiumService } from '../src/services/premium.service.js';
import type { DownloadedFile, MediaInfo, YtDlpService } from '../src/services/ytdlp.service.js';
import { ApiError } from '../src/utils/apiError.js';
import { isAllowedUrl } from '../src/utils/urlPolicy.js';

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const INFO: MediaInfo = { platform: 'youtube', title: 'Clip', thumbnail: 'https://i.ytimg.com/x.jpg', duration: 100, audioSize: 1_600_000,
  qualities: [{ quality: 90, size: 1 }, { quality: 360, size: 10 }, { quality: 1080, size: 50 }] };

class FakeYtDlp {
  cleaned: DownloadedFile[] = []; lastDownload: unknown[] = []; fail: ApiError | null = null;
  isAllowed = isAllowedUrl;
  async init() {} async close() {}
  async fetchInfo(_u: string) { if (this.fail) throw this.fail; return INFO; }
  private async file(ext: string): Promise<DownloadedFile> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-app-')); const p = path.join(dir, `media.${ext}`);
    fs.writeFileSync(p, 'FILEBYTES'); return { path: p, dir, ext };
  }
  async download(u: string, q: number) { this.lastDownload = ['video', u, q]; return this.file('mp4'); }
  async downloadAudio(u: string, f: string) { this.lastDownload = ['audio', u, f]; return this.file(f); }
  async cleanup(f: DownloadedFile) { this.cleaned.push(f); fs.rmSync(f.dir, { recursive: true, force: true }); }
}

const KEY_SECRET = 'test_secret_value';
let app: Awaited<ReturnType<typeof buildApp>>;
async function setup(env: Record<string, string> = {}) {
  const ytdlp = new FakeYtDlp();
  const premium = new PremiumService({ keyId: 'rzp_test_AbCdEfGh123', keySecret: KEY_SECRET, tokenSecret: 'x'.repeat(40), pricePaise: 1900, days: 30 });
  app = await buildApp(loadConfig({ NODE_ENV: 'test', DATA_DIR: os.tmpdir(), ...env } as any), { ytdlp: ytdlp as unknown as YtDlpService, premium });
  return { ytdlp, premium };
}
afterEach(async () => { await app?.close(); });

describe('health and error contract', () => {
  it('health ok', async () => { await setup(); const r = await app.inject('/api/health'); expect(r.statusCode).toBe(200); expect(r.json().status).toBe('ok'); });
  it('unknown route => JSON 404 in { success:false, message } shape', async () => {
    await setup(); const r = await app.inject('/api/nope');
    expect(r.statusCode).toBe(404); expect(r.json()).toEqual({ success: false, message: 'Not found.' });
  });
  it('malformed JSON => 400 JSON error, no stack/paths', async () => {
    await setup();
    const r = await app.inject({ method: 'POST', url: '/api/premium/verify', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect(r.statusCode).toBe(400); expect(r.json().success).toBe(false); expect(r.body).not.toContain('/src/');
  });
});

describe('POST/GET /api/media/info', () => {
  it('rejects a missing url', async () => {
    await setup(); const r = await app.inject({ method: 'POST', url: '/api/media/info' });
    expect(r.statusCode).toBe(400); expect(r.json().message).toBe('Missing parameter: url');
  });
  it.each(['https://evil.example/a.mp4', 'http://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://169.254.169.254/'])('rejects %s', async (u) => {
    await setup(); const r = await app.inject({ method: 'POST', url: `/api/media/info?url=${encodeURIComponent(u)}` });
    expect(r.statusCode).toBe(400); expect(r.json()).toEqual({ success: false, message: 'Invalid or unsupported link.' });
  });
  it('returns the original response shape (query param, as the existing frontend sends it)', async () => {
    await setup(); const r = await app.inject({ method: 'POST', url: `/api/media/info?url=${encodeURIComponent(YT)}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      success: true, platform: 'youtube', title: 'Clip', thumbnail: 'https://i.ytimg.com/x.jpg', freeMaxQuality: 4320, audioSize: 1_600_000, mp3Size: 3_062_500,
      formats: [{ quality: '360p', value: 360, locked: false, size: 10 }, { quality: '1080p', value: 1080, locked: false, size: 50 }],   // 90p dropped (<144)
    });
  });
  it('also accepts GET and a JSON body', async () => {
    await setup();
    expect((await app.inject(`/api/media/info?url=${encodeURIComponent(YT)}`)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/media/info', payload: { url: YT } })).statusCode).toBe(200);
  });
  it('surfaces service errors with their status and message', async () => {
    const { ytdlp } = await setup(); ytdlp.fail = new ApiError(502, 'This content is private.');
    const r = await app.inject({ method: 'POST', url: `/api/media/info?url=${encodeURIComponent(YT)}` });
    expect(r.statusCode).toBe(502); expect(r.json()).toEqual({ success: false, message: 'This content is private.' });
  });
});

describe('GET /api/media/download', () => {
  const dl = (q: string) => `/api/media/download?url=${encodeURIComponent(YT)}${q}`;
  it('streams the file with safe headers, then cleans up', async () => {
    const { ytdlp } = await setup();
    const r = await app.inject(dl('&quality=720p'));
    expect(r.statusCode).toBe(200); expect(r.body).toBe('FILEBYTES');
    expect(r.headers['content-type']).toBe('video/mp4');
    expect(r.headers['content-disposition']).toBe('attachment; filename="download.mp4"');
    expect(ytdlp.lastDownload).toEqual(['video', YT, 720]);
    await new Promise((res) => setTimeout(res, 50));
    expect(ytdlp.cleaned.length).toBe(1);
  });
  it('audio formats are limited to mp3/m4a', async () => {
    const { ytdlp } = await setup();
    const ok = await app.inject(dl('&audio=MP3'));
    expect(ok.statusCode).toBe(200); expect(ok.headers['content-type']).toBe('audio/mpeg'); expect(ytdlp.lastDownload).toEqual(['audio', YT, 'mp3']);
    const bad = await app.inject(dl('&audio=wav'));
    expect(bad.statusCode).toBe(400); expect(bad.json().message).toBe('Invalid audio format.');
  });
  it('rejects bad quality and injection attempts without reaching the service', async () => {
    const { ytdlp } = await setup();
    for (const q of ['abc', '99p', '720p%3B%20rm%20-rf%20%2F']) expect((await app.inject(dl(`&quality=${q}`))).statusCode).toBe(400);
    expect(ytdlp.lastDownload).toEqual([]);
    expect((await app.inject('/api/media/download?url=file%3A%2F%2F%2Fetc%2Fpasswd')).statusCode).toBe(400);
    expect((await app.inject('/api/media/download')).json().message).toBe('Missing parameter: url');
  });
  it('requires a valid premium token above FREE_MAX_QUALITY', async () => {
    const { premium } = await setup({ FREE_MAX_QUALITY: '1080' });
    expect((await app.inject(dl('&quality=2160p'))).statusCode).toBe(402);
    expect((await app.inject(dl('&quality=1080p'))).statusCode).toBe(200);
    const sig = createHmac('sha256', KEY_SECRET).update('order_ABC123|pay_XYZ789').digest('hex');
    const { token } = await premium.verifyAndIssue('order_ABC123', 'pay_XYZ789', sig);
    expect((await app.inject(dl(`&quality=2160p&token=${token}`))).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: dl('&quality=2160p'), headers: { 'x-premium-token': token } })).statusCode).toBe(200);
    expect((await app.inject(dl('&quality=2160p&token=forged.token'))).statusCode).toBe(402);
  });
});

describe('/api/premium', () => {
  it('order: 503 when Razorpay is not configured (placeholder keys), never a fake order', async () => {
    const ytdlp = new FakeYtDlp();
    app = await buildApp(loadConfig({ NODE_ENV: 'test', DATA_DIR: os.tmpdir() } as any), { ytdlp: ytdlp as unknown as YtDlpService });
    const r = await app.inject({ method: 'POST', url: '/api/premium/order' });
    expect(r.statusCode).toBe(503); expect(r.json().success).toBe(false);
  });
  it('verify: signature required; success returns a token that /status accepts', async () => {
    await setup();
    const bad = await app.inject({ method: 'POST', url: '/api/premium/verify', payload: { razorpay_order_id: 'order_ABC123', razorpay_payment_id: 'pay_XYZ789', razorpay_signature: 'a'.repeat(64) } });
    expect(bad.statusCode).toBe(400); expect(bad.json().message).toBe('Payment verification failed.');
    const sig = createHmac('sha256', KEY_SECRET).update('order_ABC123|pay_XYZ789').digest('hex');
    const ok = await app.inject({ method: 'POST', url: '/api/premium/verify', payload: { razorpay_order_id: 'order_ABC123', razorpay_payment_id: 'pay_XYZ789', razorpay_signature: sig } });
    expect(ok.statusCode).toBe(200);
    const { token, expiresAt } = ok.json();
    const st = await app.inject({ url: '/api/premium/status', headers: { 'x-premium-token': token } });
    expect(st.json()).toEqual({ success: true, active: true, expiresAt });
    expect((await app.inject('/api/premium/status')).json()).toEqual({ success: true, active: false, expiresAt: 0 });
  });
  it('verify: a frontend-only "success" flag is ignored; missing fields => 400', async () => {
    await setup();
    const r = await app.inject({ method: 'POST', url: '/api/premium/verify', payload: { paid: true } });
    expect(r.statusCode).toBe(400);
  });
});

describe('security: CORS and rate limiting', () => {
  it('allows only configured origins and exposes Content-Disposition', async () => {
    await setup({ CORS_ORIGINS: 'http://localhost:3000' });
    const ok = await app.inject({ method: 'OPTIONS', url: '/api/media/download', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const get = await app.inject({ url: '/api/health', headers: { origin: 'http://localhost:3000' } });
    expect(get.headers['access-control-expose-headers']).toContain('Content-Disposition');
    const evil = await app.inject({ url: '/api/health', headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBe(undefined);
  });
  it('429s after the per-minute limit with Retry-After and CORS headers; other buckets are unaffected', async () => {
    await setup({ RATE_LIMIT_DOWNLOAD_PER_MINUTE: '2' });
    const url = `/api/media/download?url=${encodeURIComponent(YT)}`;
    const h = { origin: 'http://localhost:3000' };
    expect((await app.inject({ url, headers: h })).statusCode).toBe(200);
    expect((await app.inject({ url, headers: h })).statusCode).toBe(200);
    const blocked = await app.inject({ url, headers: h });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(blocked.json().success).toBe(false);
    expect((await app.inject(`/api/media/info?url=${encodeURIComponent(YT)}`)).statusCode).toBe(200);
  });
});
