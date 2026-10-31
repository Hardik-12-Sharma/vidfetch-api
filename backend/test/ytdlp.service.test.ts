import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseInfo, YtDlpService, friendlyError } from '../src/services/ytdlp.service.js';
import { ApiError } from '../src/utils/apiError.js';
import { ProcessRunner, type RunOptions } from '../src/utils/exec.js';

// A stand-in `yt-dlp` executable. It speaks just enough of the CLI for the service under test and
// logs every invocation, so we can assert on the exact (server-built) arguments.
const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(a) + '\\n');
const url = a[a.length - 1];
const err = (m, c = 1) => { process.stderr.write(m + '\\n'); process.exit(c); };
if (url.includes('BBBBBBBBBBB')) err('ERROR: [youtube] BBBBBBBBBBB: Video unavailable');
if (url.includes('CCCCCCCCCCC')) setInterval(() => {}, 1000);           // hangs until killed
else if (a.includes('-J')) {
  process.stdout.write(JSON.stringify({ title: 'Test clip', thumbnail: 'https://i.ytimg.com/x.jpg', duration: 100, formats: [
    { vcodec: 'none', acodec: 'mp4a', ext: 'm4a', abr: 128, filesize: 1600000 },
    { vcodec: 'avc1.64', acodec: 'none', width: 1920, height: 1080, tbr: 4000, filesize: 50000000 },
    { vcodec: 'vp9', acodec: 'none', width: 1920, height: 1080, tbr: 2000, filesize: 30000000 },
    { vcodec: 'avc1.4d', acodec: 'mp4a', width: 640, height: 360, tbr: 500 },
    { vcodec: 'avc1.4d', acodec: 'none', width: 1080, height: 1920, tbr: 3000, filesize: 40000000 },
  ] }));
} else {
  const out = a[a.indexOf('-o') + 1];
  const ext = a.includes('-x') ? a[a.indexOf('--audio-format') + 1] : 'mp4';
  fs.writeFileSync(out.replace('%(ext)s', ext), 'FAKEMEDIA');
}
`;
let dir: string, bin: string, log: string, tmp: string;
// Runs the fake yt-dlp script through Node.js.
// This avoids Windows failing to execute extensionless scripts directly.
class NodeScriptRunner extends ProcessRunner {
  override run(cmd: string, args: string[], options: RunOptions) {
    if (cmd === bin) {
      return super.run(process.execPath, [bin, ...args], options);
    }

    // Keep normal behavior for other executables, including missing binaries.
    return super.run(cmd, args, options);
  }
}
const mk = (extra: Partial<ConstructorParameters<typeof YtDlpService>[0]> = {}) =>
  new YtDlpService(
    {
      binary: bin,
      maxConcurrent: 2,
      maxFilesize: '2G',
      tmpDir: tmp,
      slotWaitMs: 100,
      ...extra,
    },
    new NodeScriptRunner(),
  );
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
const YT = (id: string) => `https://www.youtube.com/watch?v=${id}`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-stub-'));

  bin = path.join(dir, 'yt-dlp-stub.cjs');
  log = path.join(dir, 'calls.log');
  tmp = path.join(dir, 'tmp');

  // A .cjs file is executed explicitly through NodeScriptRunner.
  // No executable permission or shebang is needed.
  fs.writeFileSync(
    bin,
    STUB.replace('#!/usr/bin/env node', ''),
    { mode: 0o600 },
  );

  process.env.STUB_LOG = log;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('info parsing', () => {
  it('derives real qualities from metadata (short side, prefers h264, adds audio to video-only)', async () => {
    const s = mk(); await s.init();
    const info = await s.fetchInfo(YT('AAAAAAAAAAA'));
    expect(info.title).toBe('Test clip');
    expect(info.platform).toBe('youtube');
    expect(info.qualities.map((q) => q.quality)).toEqual([360, 1080]);        // 1080x1920 portrait counts as 1080; no invented ladder
    expect(info.qualities[1]).toEqual({ quality: 1080, size: 50000000 + 1600000 });   // among avc1 candidates the higher-bitrate one wins, then audio size is added (video-only)
    expect(info.qualities[0]!.size).toBe(Math.floor(500 * 100 * 125));        // estimated from tbr*duration
    expect(info.audioSize).toBe(1600000);
    await s.close();
  });
  it('uses the first entry of a carousel', () => {
    const j = JSON.stringify({ title: 'album', entries: [{ title: 'first', duration: 10, formats: [{ vcodec: 'avc1', acodec: 'aac', width: 720, height: 1280, filesize: 5 }] }, null] });
    const i = parseInfo(j, 'https://www.instagram.com/p/abc/');
    expect(i.title).toBe('first'); expect(i.platform).toBe('instagram'); expect(i.qualities[0]!.quality).toBe(720);
  });
  it('caches results and de-duplicates concurrent lookups', async () => {
    const s = mk(); await s.init();
    const before = calls().length;
    const u = YT('DDDDDDDDDDD');
    await Promise.all([s.fetchInfo(u), s.fetchInfo(u)]);
    await s.fetchInfo(u);
    expect(calls().length - before).toBe(1);
    await s.close();
  });
  it('passes a fixed argument list with the URL last, after `--`', async () => {
    const s = mk(); await s.init();
    const u = YT('EEEEEEEEEEE'); await s.fetchInfo(u);
    const args = calls().at(-1)!;
    expect(args.slice(-2)).toEqual(['--', u]);
    expect(args).toContain('--no-playlist'); expect(args).toContain('-J');
    await s.close();
  });
});

describe('errors', () => {
  it('maps yt-dlp stderr to a friendly message', async () => {
    const s = mk(); await s.init();
    await expect(s.fetchInfo(YT('BBBBBBBBBBB'))).rejects.toThrow('This content is unavailable or was removed.');
    await s.close();
  });
  it('times out and kills a hung yt-dlp', async () => {
    const s = mk({ infoTimeoutMs: 300 }); await s.init();
    const err = await s.fetchInfo(YT('CCCCCCCCCCC')).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError); expect(err.status).toBe(504);
    expect(s.runner.activeCount).toBe(0);
    await s.close();
  });
  it('reports a missing yt-dlp binary truthfully', async () => {
    const s = mk({ binary: path.join(dir, 'nope') }); await s.init();
    await expect(s.fetchInfo(YT('FFFFFFFFFFF'))).rejects.toThrow('yt-dlp not found');
    await s.close();
  });
  it('friendlyError covers the original cases', () => {
    expect(friendlyError('Sign in to confirm you’re not a bot', 'youtube')).toMatch(/blocking this server/);
    expect(friendlyError('ERROR: Login required', 'instagram')).toMatch(/Instagram is requesting login/);
    expect(friendlyError('This video is private', 'youtube')).toBe('This content is private.');
    expect(friendlyError('Requested format is not available', 'youtube')).toMatch(/quality is not available/);
    expect(friendlyError('anything else', 'youtube')).toBe('Could not fetch this link. Please try again.');
  });
  it('friendlyError names X correctly (never Instagram)', () => {
    expect(friendlyError('ERROR: [twitter] 1: NSFW tweet requires authentication. Use --cookies, --cookies-from-browser or --username and --password for authentication', 'x')).toMatch(/X post is private/);
    expect(friendlyError('ERROR: [twitter] 1: No video could be found in this tweet', 'x')).toBe('This post has no video.');
    expect(friendlyError('ERROR: [twitter] 1850000000000000429: HTTP Error 429: Too Many Requests', 'x')).toMatch(/X is limiting/);
    expect(friendlyError('ERROR: [twitter] 1850000000000000429: Tweet unavailable', 'x')).toBe('This content is unavailable or was removed.');
  });
});

describe('download lifecycle', () => {
  it('downloads video, then cleanup removes the working directory', async () => {
    const s = mk(); await s.init();
    const f = await s.download(YT('GGGGGGGGGGG'), 720);
    expect(f.ext).toBe('mp4'); expect(fs.readFileSync(f.path, 'utf8')).toBe('FAKEMEDIA');
    const args = calls().at(-1)!;
    expect(args[args.indexOf('-S') + 1]).toBe('res:720,vcodec:h264,acodec:aac');
    expect(args).toContain('--merge-output-format'); expect(args[args.indexOf('--max-filesize') + 1]).toBe('2G');
    await s.cleanup(f);
    expect(fs.existsSync(f.dir)).toBe(false);
    await s.close();
  });
  it('extracts mp3 and m4a audio', async () => {
    const s = mk(); await s.init();
    for (const fmt of ['mp3', 'm4a'] as const) {
      const f = await s.downloadAudio(YT('HHHHHHHHHHH'), fmt);
      expect(f.ext).toBe(fmt); await s.cleanup(f);
    }
    await expect(s.downloadAudio(YT('HHHHHHHHHHH'), 'wav' as any)).rejects.toThrow('Unsupported audio format');
    await s.close();
  });
  it('removes the work dir when the download fails', async () => {
    const s = mk(); await s.init();
    await expect(s.download(YT('BBBBBBBBBBB'), 720)).rejects.toThrow();
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith('dl-'))).toEqual([]);
    await s.close();
  });
  it('cancels: aborting kills the process and cleans up', async () => {
    const s = mk(); await s.init();
    const ac = new AbortController();
    const p = s.download(YT('CCCCCCCCCCC'), 720, ac.signal).catch((e) => e);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.runner.activeCount).toBe(1);
    ac.abort();
    const err = await p;
    expect(err.status).toBe(499); expect(s.runner.activeCount).toBe(0);
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith('dl-'))).toEqual([]);
    await s.close();
  });
  it('enforces the download timeout', async () => {
    const s = mk({ downloadTimeoutMs: 300 }); await s.init();
    const err = await s.download(YT('CCCCCCCCCCC'), 720).catch((e) => e);
    expect(err.status).toBe(504); expect(s.runner.activeCount).toBe(0);
    await s.close();
  });
  it('limits concurrency: extra requests get 503 instead of piling up', async () => {
    const s = mk({ maxConcurrent: 1, downloadTimeoutMs: 1500 }); await s.init();
    const first = s.download(YT('CCCCCCCCCCC'), 720).catch((e) => e);
    await new Promise((r) => setTimeout(r, 200));
    const second = await s.download(YT('GGGGGGGGGGG'), 720).catch((e) => e);
    expect(second.status).toBe(503);
    await first; await s.close();
  });
  it('shutdown (close) kills running children and deletes work dirs', async () => {
    const s = mk(); await s.init();
    const p = s.download(YT('CCCCCCCCCCC'), 720).catch((e) => e);
    await new Promise((r) => setTimeout(r, 300));
    await s.close(); await p;
    expect(s.runner.activeCount).toBe(0);
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith('dl-'))).toEqual([]);
  });
  it('refuses URLs outside the allow-list even if a caller skips validation', async () => {
    const s = mk(); await s.init();
    await expect(s.download('https://evil.example/x.mp4', 720)).rejects.toThrow('Invalid or unsupported link.');
    await s.close();
  });
});
