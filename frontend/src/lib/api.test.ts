import { afterEach, describe, expect, it } from 'vitest';
import { downloadMedia, errorMessage, fetchMediaInfo, NETWORK_ERROR } from './api';

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });
const stub = (fn: (url: string, init?: RequestInit) => Response | Promise<Response>) => { globalThis.fetch = (async (u: any, i?: any) => fn(String(u), i)) as typeof fetch; };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// Read Blob contents in environments where Blob.text() is unavailable.
const readBlobAsText = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);

    reader.readAsText(blob);
  });

describe('fetchMediaInfo', () => {
  it('POSTs ?url= to the configured backend and returns the parsed body', async () => {
    let seen = { url: '', method: '' };
    stub((url, init) => { seen = { url, method: String(init?.method) }; return json({ success: true, platform: 'youtube', title: 'T', thumbnail: null, freeMaxQuality: 4320, audioSize: 0, mp3Size: 0, formats: [] }); });
    const info = await fetchMediaInfo('https://youtu.be/dQw4w9WgXcQ');
    expect(info.title).toBe('T');
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('http://localhost:4000/api/media/info?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ'));
  });
  it('surfaces the backend message on errors', async () => {
    stub(() => json({ success: false, message: 'This content is private.' }, 502));
    await expect(fetchMediaInfo('https://youtu.be/dQw4w9WgXcQ')).rejects.toThrow('This content is private.');
  });
  it('handles non-JSON responses', async () => {
    stub(() => new Response('<html>', { status: 502 }));
    await expect(fetchMediaInfo('https://youtu.be/dQw4w9WgXcQ')).rejects.toThrow('Server returned an invalid response.');
  });
});

describe('downloadMedia', () => {
  it('returns the blob and the filename from Content-Disposition', async () => {
    stub(() => new Response('BYTES', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="download.mp3"' } }));
    const r = await downloadMedia('https://youtu.be/dQw4w9WgXcQ', 'best', 'mp3');
    expect(r.filename).toBe('download.mp3');
    expect(await readBlobAsText(r.blob)).toBe('BYTES');
  });
  it('sends quality and audio as query params', async () => {
    let url = '';
    stub((u) => { url = u; return new Response('x'); });
    await downloadMedia('https://youtu.be/dQw4w9WgXcQ', '720p');
    expect(url).toContain('quality=720p'); expect(url).not.toContain('audio=');
  });
  it('shows the server error message (e.g. busy / premium needed)', async () => {
    stub(() => json({ success: false, message: 'This quality needs Premium.' }, 402));
    await expect(downloadMedia('https://youtu.be/dQw4w9WgXcQ', '2160p')).rejects.toThrow('This quality needs Premium.');
  });
});

describe('errorMessage', () => {
  it('maps network failures to the friendly text', () => {
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe(NETWORK_ERROR);
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });
});
