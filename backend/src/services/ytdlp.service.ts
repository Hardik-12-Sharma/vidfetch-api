import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from '../utils/apiError.js';
import { ProcessRunner, type RunResult } from '../utils/exec.js';
import { removeDir, sweepStale } from '../utils/files.js';
import { BoundedQueue, Semaphore } from '../utils/semaphore.js';
import { detectPlatform, isAllowedUrl, type Platform } from '../utils/urlPolicy.js';

export interface YtDlpOptions {
  binary: string;
  ffmpegLocation?: string;
  maxConcurrent: number;
  maxFilesize: string;     // e.g. "2G" (validated by config)
  tmpDir: string;
  infoTimeoutMs?: number;      // default 40s
  downloadTimeoutMs?: number;  // default 300s
  slotWaitMs?: number;         // default 5s
  infoWaitMs?: number;         // default 60s
  ytClients?: string;          // yt-dlp youtube player_client list for downloads, default "default,mweb"
  infoClients?: string;        // faster client(s) tried first for the info call only; falls back to ytClients on failure
  cacheDir?: string;           // persistent yt-dlp cache (player JS / challenge solutions)
  warmup?: boolean;            // pre-load player JS + Deno once at startup
  cookiesFile?: string;        // Netscape cookies.txt (fixes Instagram "empty media response" / YouTube "not a bot")
  reuseInfo?: boolean;         // reuse the info JSON for the download (skips a 2nd extraction) + download the exact format shown in the size list
  aria2c?: boolean;            // use aria2c (16 connections) for http downloads; needs aria2c installed
  cookiesFromBrowser?: string; // e.g. "chrome" or "firefox": yt-dlp reads the logged-in browser's cookies
}
export interface QualityInfo { quality: number; size: number; selector?: string }
export interface MediaInfo { platform: Platform; title: string; thumbnail: string | null; qualities: QualityInfo[]; audioSize: number; duration: number }
export interface DownloadedFile { path: string; dir: string; ext: string }
export interface DownloadProgress { status?: 'downloading' | 'merging'; percent?: number }
export type ProgressReporter = (p: DownloadProgress) => void;

/** yt-dlp prints one `VFPROG <downloaded> <total> <estimate>` line per update (see --progress-template below). */
export const PROGRESS_TEMPLATE = 'download:VFPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s';

/**
 * Turns yt-dlp output lines into an overall percentage.
 * Video + audio are two separate downloads (video first), so a 2-stream download maps video to 0-90% and audio to 90-99%.
 */
export function progressTracker(streams: number, report?: ProgressReporter): ((line: string) => void) | undefined {
  if (!report) return undefined;
  let idx = 0, last = 0;
  return (line: string) => {
    if (line.startsWith('VFPROG ')) {
      const [, d, t, e] = line.split(/\s+/);
      const done = Number(d), total = Number(t) || Number(e);
      if (!Number.isFinite(done) || !(total > 0)) { report({ status: 'downloading' }); return; }
      if (done < last) idx++;                             // byte counter went back => the next stream started
      last = done;
      const frac = Math.min(1, done / total);
      const pct = streams > 1 ? (idx === 0 ? frac * 90 : 90 + frac * 9) : frac * 99;
      report({ status: 'downloading', percent: pct });
    } else if (/^\[(Merger|ExtractAudio|VideoConvertor|Fixup\w*)\]/.test(line)) {
      report({ status: 'merging', percent: 99 });
    }
  };
}

interface YtFormat { format_id?: string; format_note?: string; vcodec?: string; acodec?: string; width?: number; height?: number; tbr?: number; abr?: number; ext?: string; filesize?: number; filesize_approx?: number }
interface YtItem { title?: string; thumbnail?: string; duration?: number; formats?: YtFormat[]; entries?: Array<YtItem | null> }

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const hasNone = (c: unknown) => !c || c === 'none';

// ---- info parsing (ported from YtDlpService.qualities/audioSize/formatSize) ----
function formatSize(f: YtFormat, duration: number): number {
  let size = num(f.filesize) || num(f.filesize_approx);
  if (size <= 0 && num(f.tbr) > 0 && duration > 0) size = Math.floor(num(f.tbr) * duration * 125);
  return Math.max(size, 0);
}
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.=-]*$/;
function pickAudio(item: YtItem): { id?: string; size: number } {
  const duration = num(item.duration);
  let best = 0, bestScore = -1, id: string | undefined;
  for (const f of item.formats ?? []) {
    if (!hasNone(f.vcodec) || hasNone(f.acodec)) continue;       // audio-only formats only
    const size = formatSize(f, duration);
    const score = (f.ext === 'm4a' ? 1_000_000 : 0) + Math.floor(num(f.abr));
    if (size > 0 && score > bestScore) { bestScore = score; best = size; id = f.format_id; }
  }
  return { id, size: best };
}
export const audioSize = (item: YtItem): number => pickAudio(item).size;
const better = (a: YtFormat, b: YtFormat) => {
  const ah = str(a.vcodec).startsWith('avc1'), bh = str(b.vcodec).startsWith('avc1');
  return ah !== bh ? ah : num(a.tbr) > num(b.tbr);
};
// Standard ladder, so odd sizes (cropped / letterboxed videos like 256x122) show as 144p, 1080p ... like YouTube does.
const STD_QUALITIES = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];
const snapQuality = (n: number) => STD_QUALITIES.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
function qualityLabel(f: YtFormat, w: number, h: number): number {
  const note = /^(\d{3,4})p/.exec(str(f.format_note));                 // YouTube already says "480p", "1080p60" ...
  if (note) return snapQuality(Number(note[1]));
  if (!(w > 0 && h > 0)) return Math.max(w, h) > 0 ? snapQuality(Math.max(w, h)) : 0;
  const long = Math.max(w, h), short = Math.min(w, h);
  // short side (1080x1920 reel => 1080); ultra-wide videos (1920x804) are named by their 16:9 height (1080).
  return snapQuality(long / short > 16 / 9 + 0.05 ? (long * 9) / 16 : short);
}
export function qualities(item: YtItem): QualityInfo[] {
  const duration = num(item.duration), audio = pickAudio(item);
  const best = new Map<number, YtFormat>();
  for (const f of item.formats ?? []) {
    if (hasNone(f.vcodec)) continue;
    const w = num(f.width), h = num(f.height);
    const q = qualityLabel(f, w, h);
    if (q <= 0) continue;
    const cur = best.get(q);
    if (!cur || better(f, cur)) best.set(q, f);
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([q, f]) => {
    let size = formatSize(f, duration);
    const videoOnly = hasNone(f.acodec);
    if (size > 0 && videoOnly) size += audio.size;              // video-only stream: add audio estimate
    // Exact "videoId+audioId" the download will use, so the size shown is the size of the file you get.
    const vid = f.format_id, aid = audio.id;
    const selector = vid && SAFE_ID.test(vid) ? (!videoOnly ? vid : aid && SAFE_ID.test(aid) ? `${vid}+${aid}` : undefined) : undefined;
    return { quality: q, size, selector };
  });
}
export function parseInfo(json: string, url: string): MediaInfo {
  const root = JSON.parse(json) as YtItem;
  const first = Array.isArray(root.entries) && root.entries[0] ? root.entries[0] : null;
  const item = first ?? root;                                    // carousel: first item
  return {
    platform: detectPlatform(url),
    title: item.title ?? root.title ?? 'Video',
    thumbnail: item.thumbnail ?? root.thumbnail ?? null,
    qualities: qualities(item), audioSize: audioSize(item), duration: num(item.duration),
  };
}

// ---- error mapping (ported from YtDlpService.friendlyError) ----
export function friendlyError(stderr: string, platform: Platform): string {
  const s = (stderr ?? '').toLowerCase();
  if (s.includes('ffmpeg') && (s.includes('not found') || s.includes('not installed'))) return 'Server setup problem: ffmpeg is missing.';
  if (s.includes('confirm your age')) return 'This video is age-restricted and cannot be downloaded here.';
  if (s.includes('sign in to confirm') || s.includes('not a bot')) return 'YouTube is blocking this server right now. Please try again later.';
  if (platform === 'facebook' && /log ?in|registered users|cannot parse data|private/.test(s)) return 'This Facebook video is private or needs login. Only public videos can be downloaded.';
  // X: its login and block messages mention `--cookies`, which would otherwise be reported as an Instagram problem below.
  if (platform === 'x' && /rate.?limit|http error 429|too many requests/.test(s)) return 'X is limiting requests from this server right now. Please try again later.';
  if (platform === 'x' && /nsfw|age-restricted|protected|authenticat|authoriz|log ?in|--cookies/.test(s)) return 'This X post is private, age-restricted or needs login. Only public posts can be downloaded.';
  if (s.includes('login required') || s.includes('rate-limit')) {
    return platform === 'youtube'
      ? 'YouTube is blocking this server right now. Please try again later.'
      : 'Instagram is requesting login or has rate-limited this server. Try another public link.';
  }
  if (s.includes('empty media response') || s.includes('--cookies')) {
    return platform === 'youtube'
      ? 'YouTube is blocking this server right now. Please try again later.'
      : 'Instagram did not return this post (it may be private, or the server needs login cookies). Try another public link.';
  }
  if (s.includes('there is no video in this post') || s.includes('no video could be found') || s.includes('no media found')) return 'This post has no video.';
  if (s.includes('unsupported url')) return 'Invalid or unsupported link.';
  if (s.includes('private')) return 'This content is private.';
  if (s.includes('requested format is not available')) return 'This quality is not available for this video.';
  if (s.includes('max-filesize')) return 'This file is too large to download here.';
  if (s.includes('unavailable') || s.includes('not found') || s.includes('http error 404')) return 'This content is unavailable or was removed.';
  return 'Could not fetch this link. Please try again.';
}

interface Cached { info: MediaInfo; expires: number }

export class YtDlpService {
  private slots: Semaphore;
  private infoQueue: BoundedQueue;
  private cache = new Map<string, Cached>();
  private inflight = new Map<string, Promise<MediaInfo>>();
  private raw = new Map<string, { json: string; expires: number }>();   // small, short-lived: signed media URLs expire
  private sweeper?: NodeJS.Timeout;
  private dirs = new Set<string>();
  readonly runner: ProcessRunner;

  constructor(private o: YtDlpOptions, runner = new ProcessRunner()) {
    const n = Math.max(1, o.maxConcurrent);
    this.slots = new Semaphore(n);
    this.infoQueue = new BoundedQueue(n * 2, 20);
    this.runner = runner;
  }

  async init() {
    // Log the installed yt-dlp version for deployment diagnostics.
    try {
      const result = await this.runner.run(
        this.o.binary,
        ['--version'],
        { timeoutMs: 15_000 }
      );

      console.log(
        `[diagnostics] yt-dlp version: ${result.stdout.trim()}`
      );
    } catch (error) {
      console.error('[diagnostics] Unable to detect yt-dlp version:', error);
    }

    await fs.mkdir(this.o.tmpDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.o.tmpDir, { recursive: true, mode: 0o700 });
    await sweepStale(this.o.tmpDir, 60 * 60_000);
    this.sweeper = setInterval(() => void sweepStale(this.o.tmpDir, 60 * 60_000), 10 * 60_000);
    this.sweeper.unref();
    if (this.o.cacheDir) await fs.mkdir(this.o.cacheDir, { recursive: true, mode: 0o700 });
    // Hosts such as Render mount secret files read-only, but yt-dlp saves cookies back to the file (Errno 30).
    // So work on a writable private copy (outside tmpDir, which is swept).
    if (this.o.cookiesFile) {
      try {
        const copy = path.join(os.tmpdir(), 'vidfetch-cookies.txt');
        await fs.copyFile(this.o.cookiesFile, copy);
        await fs.chmod(copy, 0o600);
        this.o.cookiesFile = copy;
      } catch { /* keep the original path; yt-dlp will report a clear error */ }
    }
    // Fire-and-forget: the first real user should not pay the cold-start cost (player JS download, Deno start).
    if (this.o.warmup) void this.fetchInfo('https://www.youtube.com/watch?v=jNQXAC9IVRw').catch(() => undefined);
  }
  /** Graceful shutdown: kill children, delete working dirs. */
  async close() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.runner.killAll();
    await Promise.all([...this.dirs].map((d) => removeDir(d)));
    this.dirs.clear();
  }

  isAllowed = isAllowedUrl;

  // ---------- info ----------
  async fetchInfo(rawUrl: string): Promise<MediaInfo> {
    const url = rawUrl.trim();
    const hit = this.cache.get(url);
    if (hit && hit.expires > Date.now()) return hit.info;

    let p = this.inflight.get(url);
    if (!p) {
      p = this.infoQueue.run(() => this.loadInfo(url));
      this.inflight.set(url, p);
      const clear = () => { if (this.inflight.get(url) === p) this.inflight.delete(url); };
      p.then(clear, clear);
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new ApiError(504, 'Timed out while fetching the media.')), this.o.infoWaitMs ?? 60_000); });
    try {
      const info = await Promise.race([p, timeout]);
      const now = Date.now();
      if (this.cache.size > 500) {
        for (const [k, v] of this.cache) if (v.expires <= now) this.cache.delete(k);
        if (this.cache.size > 500) this.cache.clear();
      }
      this.cache.set(url, { info, expires: now + 60 * 60_000 });
      return info;
    } finally { clearTimeout(timer); }
  }

  private async loadInfo(url: string): Promise<MediaInfo> {
    const platform = detectPlatform(url);
    const main = this.o.ytClients || 'default';
    const fast = this.o.infoClients;
    if (platform === 'youtube' && fast && fast !== main) {
      try { return await this.loadInfoWith(url, platform, fast); }
      catch (e) {
        // Fast client could not read this video (age-gated, unsupported...): retry once with the full client list.
        if (!(e instanceof ApiError) || e.status !== 502) throw e;
      }
    }
    return this.loadInfoWith(url, platform, main);
  }

  private async loadInfoWith(url: string, platform: Platform, clients: string): Promise<MediaInfo> {
    const t0 = Date.now();
    try {
      const info = await this.loadInfoRaw(url, platform, clients);
      console.log(`[yt-dlp info] ${platform} clients=${clients} ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return info;
    } catch (e) {
      console.log(`[yt-dlp info] ${platform} clients=${clients} FAILED in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${(e as Error).message}`);
      throw e;
    }
  }

  private async loadInfoRaw(url: string, platform: Platform, clients: string): Promise<MediaInfo> {
    const r = await this.runner.run(this.o.binary, [...this.baseArgs(platform, clients), '-J', '--', url], { timeoutMs: this.o.infoTimeoutMs ?? 40_000 });
    this.throwIfFailed(r, platform);
    const out = r.stdout.trim();
    if (r.code !== 0 || !out.startsWith('{')) {
      console.error(`[yt-dlp info] exit=${r.code} stderr: ${r.stderr.trim().slice(-600) || '(empty)'}`);
      throw new ApiError(502, friendlyError(r.stderr, platform));
    }
    let info: MediaInfo;
    try { info = parseInfo(out, url); } catch { throw new ApiError(502, 'Could not read media details.'); }
    if (this.o.reuseInfo) {
      if (this.raw.size >= 30) { const k = this.raw.keys().next().value; if (k !== undefined) this.raw.delete(k); }
      this.raw.set(url, { json: out, expires: Date.now() + 30 * 60_000 });
    }
    return info;
  }

  // ---------- download ----------
  /** Video (+audio merged to MP4). maxQuality is an integer chosen by the server-side parser. */
  async download(rawUrl: string, maxQuality: number, signal?: AbortSignal, onProgress?: ProgressReporter): Promise<DownloadedFile> {
    const sort = `res:${Math.trunc(maxQuality)},vcodec:h264,acodec:aac`;
    return this.runDownload(rawUrl, signal, /^media\.[a-z0-9]{2,5}$/i,
      ['-S', sort, '-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
      'Could not prepare this quality (file too large, or video and audio could not be merged). Try a lower quality.', Math.trunc(maxQuality), onProgress);
  }
  async downloadAudio(rawUrl: string, fmt: 'mp3' | 'm4a', signal?: AbortSignal, onProgress?: ProgressReporter): Promise<DownloadedFile> {
    if (fmt !== 'mp3' && fmt !== 'm4a') throw new ApiError(400, 'Unsupported audio format.');
    return this.runDownload(rawUrl, signal, /^media\.(mp3|m4a)$/i,
      ['-f', fmt === 'm4a' ? 'bestaudio[ext=m4a]/bestaudio/best' : 'bestaudio/best', '-x', '--audio-format', fmt, '--audio-quality', '0'],
      'Audio download failed. Please try again.', null, onProgress);
  }

  private async runDownload(rawUrl: string, signal: AbortSignal | undefined, fileRe: RegExp, extra: string[], notFoundMsg: string, quality: number | null = null, onProgress?: ProgressReporter): Promise<DownloadedFile> {
    const url = rawUrl.trim();
    if (!this.isAllowed(url)) throw new ApiError(400, 'Invalid or unsupported link.');   // defence in depth
    const platform = detectPlatform(url);
    if (!(await this.slots.tryAcquire(this.o.slotWaitMs ?? 5000))) throw new ApiError(503, 'Server is busy. Please try again in a minute.');
    let dir: string | null = null;
    try {
      const workDir: string = await fs.mkdtemp(path.join(this.o.tmpDir, 'dl-'));
      dir = workDir;
      this.dirs.add(workDir);
      const common = [
        ...this.baseArgs(platform, this.o.ytClients),
        '--playlist-items', '1',
        '--max-filesize', this.o.maxFilesize,
        '-N', '8',
        ...(this.o.aria2c
          ? ['--downloader', 'aria2c', '--downloader', 'dash,m3u8:native', '--downloader-args', 'aria2c:-c -j 3 -x 16 -s 16 -k 1M']
          : ['--http-chunk-size', '10M']),
        '--retries', '3', '--fragment-retries', '3', '--no-part', '--no-mtime'];
      const outArgs = ['-o', path.join(workDir, 'media.%(ext)s')];
      const runOpts = { timeoutMs: this.o.downloadTimeoutMs ?? 300_000, signal };
      // Only when someone is listening: turn on yt-dlp's progress lines (baseArgs has --no-progress; the last flag wins).
      const progArgs = onProgress ? ['--progress', '--newline', '--progress-template', PROGRESS_TEMPLATE] : [];
      const withProgress = (streams: number) => ({ ...runOpts, onLine: progressTracker(streams, onProgress) });
      const cached = this.o.reuseInfo ? this.raw.get(url) : undefined;
      let r: RunResult;
      if (cached && cached.expires > Date.now()) {
        // Fast path: reuse the info JSON from the preview step => no second 5-12s extraction, and the exact format whose size was shown.
        const infoPath = path.join(workDir, 'info.json');
        await fs.writeFile(infoPath, cached.json, { mode: 0o600 });
        const selector = quality === null ? undefined : this.cache.get(url)?.info.qualities.find((x) => x.quality === quality)?.selector;
        const pick = selector ? ['-f', selector, '--merge-output-format', 'mp4'] : extra;
        const single = quality === null || (!!selector && !selector.includes('+'));
        r = await this.runner.run(this.o.binary, [...common, ...progArgs, ...pick, ...outArgs, '--load-info-json', infoPath], withProgress(single ? 1 : 2));
        if (r.code !== 0 && !r.spawnFailed && !r.aborted && !r.timedOut) {
          console.warn(`[yt-dlp download] fast path failed (exit=${r.code}), retrying with a fresh extraction: ${r.stderr.trim().slice(-300)}`);
          for (const n of await fs.readdir(workDir)) if (n.startsWith('media.')) await fs.rm(path.join(workDir, n), { force: true });
          r = await this.runner.run(this.o.binary, [...common, ...progArgs, ...extra, ...outArgs, '--', url], withProgress(quality === null ? 1 : 2));
        }
      } else {
        r = await this.runner.run(this.o.binary, [...common, ...progArgs, ...extra, ...outArgs, '--', url], withProgress(quality === null ? 1 : 2));
      }
      this.throwIfFailed(r, platform);
      if (r.code !== 0) {
        console.error(`[yt-dlp download] exit=${r.code} stderr: ${r.stderr.trim().slice(-600) || '(empty)'}`);
        throw new ApiError(502, friendlyError(r.stderr, platform));
      }
      const low = r.stderr.toLowerCase();
      if (low.includes('ffmpeg is not installed') || low.includes('ffmpeg not found')) {
        throw new ApiError(500, 'Server setup problem: ffmpeg is missing, so video and audio could not be merged.');
      }
      const found = (await fs.readdir(workDir)).find((n: string) => fileRe.test(n));
      if (!found) throw new ApiError(502, notFoundMsg);
      return { path: path.join(workDir, found), dir: workDir, ext: found.split('.').pop()!.toLowerCase() };
    } catch (e) {
      await this.cleanupDir(dir);
      throw e;
    } finally { this.slots.release(); }
  }

  async cleanup(file: DownloadedFile | null | undefined) { if (file) await this.cleanupDir(file.dir); }
  private async cleanupDir(dir: string | null) { if (dir) { this.dirs.delete(dir); await removeDir(dir); } }

  // ---------- helpers ----------
  /** Fixed, server-built arguments. Nothing from the client is ever appended except the validated URL (after `--`). */
  private baseArgs(platform: Platform, clients?: string): string[] {
    const a = [
      '--ignore-config',
      '--no-warnings',
      '--no-progress',
      '--no-playlist',
      '--socket-timeout', '15',
      '--sleep-requests', '1',
    ];

    if (this.o.ffmpegLocation) a.push('--ffmpeg-location', this.o.ffmpegLocation);
    if (this.o.cacheDir) a.push('--cache-dir', this.o.cacheDir);
    if (this.o.cookiesFile) a.push('--cookies', this.o.cookiesFile);
    else if (this.o.cookiesFromBrowser) {
      a.push('--cookies-from-browser', this.o.cookiesFromBrowser);
    }

    if (platform === 'youtube') {
      const supportedClients = ['default', 'tv', 'mweb', 'web_safari'];
      const requestedClients = (clients || 'default')
        .split(',')
        .map((client) => client.trim())
        .filter((client) => supportedClients.includes(client));

      if (requestedClients.length > 0 && !requestedClients.includes('default')) {
        a.push('--extractor-args', `youtube:player_client=${requestedClients.join(',')},skip=translated_subs`);
      } else {
        a.push('--extractor-args', 'youtube:skip=translated_subs');
      }
    }

    return a;
  }
  private throwIfFailed(r: RunResult, _platform: Platform) {
    if (r.spawnFailed) throw new ApiError(500, 'Downloader is not set up on the server (yt-dlp not found).');
    if (r.aborted) throw new ApiError(499, 'Request cancelled.');
    if (r.timedOut) throw new ApiError(504, 'Timed out while fetching the media.');
  }
}



