import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '../utils/apiError.js';
import { removeDir, sweepStale } from '../utils/files.js';
import { Semaphore } from '../utils/semaphore.js';
import { detectPlatform, isAllowedUrl, type Platform } from '../utils/urlPolicy.js';
import type { DownloadedFile, MediaInfo, ProgressReporter } from './ytdlp.service.js';
import { ProcessRunner } from '../utils/exec.js';

const INFO_API_URL = 'https://api.snapany.com/openapi/v1/extract/post';
const PROXY_API_URL = 'https://api.snapany.com/openapi/v1/youtube/proxy-download';
const DEFAULT_CACHE_TTL_MS = 20 * 60_000;
const MAX_REDIRECTS = 3;

type SnapAnyVariant = {
  quality?: number;
  quality_label?: string;
  video_url?: string;
  video_proxy_url?: string;
  video_ext?: string;
  video_codec?: string;
  video_filesize?: number;
  audio_url?: string;
  audio_proxy_url?: string;
  audio_ext?: string;
  audio_codec?: string;
  audio_filesize?: number;
};

type SnapAnyMedia = {
  media_type?: string;
  resource_url?: string;
  resource_proxy_url?: string;
  preview_url?: string;
  duration?: number;
  filesize?: number;
  variants?: SnapAnyVariant[];
};

type SnapAnyResponse = {
  site?: string;
  title?: string;
  text?: string;
  thumbnail?: string;
  duration?: number;
  medias?: SnapAnyMedia[];
};

interface CachedResponse { response: SnapAnyResponse; info: MediaInfo; expires: number }

export interface SnapAnyOptions {
  apiKey: string;
  tmpDir: string;
  maxFilesize: string;
  maxConcurrent?: number;
  ffmpegBinary?: string;
  cacheTtlMs?: number;
  apiTimeoutMs?: number;
  downloadTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const finite = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function safeExtension(value: unknown, fallback: string): string {
  const ext = typeof value === 'string' ? value.toLowerCase().replace(/^\./, '') : '';
  return /^[a-z0-9]{2,8}$/.test(ext) ? ext : fallback;
}

function parseMaxBytes(value: string): number {
  const match = /^(\d+)([KMG]?)$/i.exec(value.trim());
  if (!match) return 2 * 1024 * 1024 * 1024;
  const multiplier = match[2]?.toUpperCase() === 'G' ? 1024 ** 3 : match[2]?.toUpperCase() === 'M' ? 1024 ** 2 : match[2]?.toUpperCase() === 'K' ? 1024 : 1;
  return Number(match[1]) * multiplier;
}

function safeHttpsUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiError(502, 'The YouTube provider returned an invalid download link.'); }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
    !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || host === 'metadata.google.internal' ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[')
  ) {
    throw new ApiError(502, 'The YouTube provider returned an unsafe download link.');
  }
  return url;
}

function mediaOf(response: SnapAnyResponse, type: 'video' | 'audio'): SnapAnyMedia | undefined {
  return response.medias?.find((media) => media.media_type === type);
}

function toInfo(response: SnapAnyResponse, url: string): MediaInfo {
  const video = mediaOf(response, 'video');
  const audio = mediaOf(response, 'audio');
  if (!video) throw new ApiError(502, 'The YouTube provider returned no downloadable video.');

  const audioVariant = audio?.variants?.find((v) => v.audio_proxy_url || v.audio_url) ?? audio?.variants?.[0];
  const duration = finite(video.duration) || finite(audio?.duration) || finite(response.duration);
  const qualities = (video.variants ?? [])
    .filter((v) => finite(v.quality) >= 144 && finite(v.quality) <= 1080 && !!(v.video_proxy_url || v.video_url))
    .map((v) => ({
      quality: Math.trunc(finite(v.quality)),
      size: finite(v.video_filesize) + finite(v.audio_filesize),
    }))
    .filter((v) => v.quality > 0)
    .sort((a, b) => a.quality - b.quality)
    .filter((v, i, all) => i === all.findIndex((other) => other.quality === v.quality));

  if (!qualities.length && (video.resource_proxy_url || video.resource_url)) {
    // A progressive resource proxy is a complete file; its precise quality may not be supplied.
    const fallbackQuality = finite(video.variants?.find((v) => v.video_proxy_url || v.video_url)?.quality) || 360;
    qualities.push({ quality: fallbackQuality, size: finite(video.filesize) });
  }

  return {
    platform: detectPlatform(url) as Platform,
    title: response.title || response.text || 'YouTube video',
    thumbnail: video.preview_url || response.thumbnail || null,
    duration,
    audioSize: finite(audioVariant?.audio_filesize) || finite(audio?.filesize),
    qualities,
  };
}

export class SnapAnyService {
  private readonly slots: Semaphore;
  // Metadata previews use the lower-cost Extract Post endpoint. The proxy-download
  // endpoint is called only after a user starts a YouTube download.
  private readonly infoCache = new Map<string, CachedResponse>();
  private readonly infoInflight = new Map<string, Promise<CachedResponse>>();
  private readonly proxyCache = new Map<string, CachedResponse>();
  private readonly proxyInflight = new Map<string, Promise<CachedResponse>>();
  private readonly dirs = new Set<string>();
  private readonly fetcher: typeof fetch;
  private readonly maxBytes: number;
  private readonly ffmpegBinary: string;
  private readonly runner: ProcessRunner;
  private sweeper?: NodeJS.Timeout;

  constructor(private readonly options: SnapAnyOptions, runner = new ProcessRunner()) {
    if (!options.apiKey.trim()) throw new Error('SnapAny API key is required.');
    this.slots = new Semaphore(Math.max(1, options.maxConcurrent ?? 2));
    this.fetcher = options.fetchImpl ?? fetch;
    this.maxBytes = parseMaxBytes(options.maxFilesize);
    this.ffmpegBinary = options.ffmpegBinary || 'ffmpeg';
    this.runner = runner;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.options.tmpDir, { recursive: true, mode: 0o700 });
    await sweepStale(this.options.tmpDir, 60 * 60_000);
    this.sweeper = setInterval(() => void sweepStale(this.options.tmpDir, 60 * 60_000), 10 * 60_000);
    this.sweeper.unref();
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.runner.killAll();
    await Promise.all([...this.dirs].map((dir) => removeDir(dir)));
    this.dirs.clear();
    this.infoCache.clear();
    this.infoInflight.clear();
    this.proxyCache.clear();
    this.proxyInflight.clear();
  }

  isAllowed = isAllowedUrl;

  async fetchInfo(rawUrl: string): Promise<MediaInfo> {
    return (await this.getCachedResponse(rawUrl.trim(), 'info')).info;
  }

  async download(rawUrl: string, maxQuality: number, signal?: AbortSignal, onProgress?: ProgressReporter): Promise<DownloadedFile> {
    const url = rawUrl.trim();
    if (!this.isAllowed(url) || detectPlatform(url) !== 'youtube') throw new ApiError(400, 'Invalid or unsupported link.');
    if (!(await this.slots.tryAcquire(5_000))) throw new ApiError(503, 'Server is busy. Please try again in a minute.');

    let dir: string | null = null;
    try {
      if (signal?.aborted) throw new ApiError(499, 'Request cancelled.');
      const { response } = await this.getCachedResponse(url, 'proxy');
      const video = mediaOf(response, 'video');
      if (!video) throw new ApiError(502, 'The YouTube provider returned no downloadable video.');

      const candidates = (video.variants ?? [])
        .filter((v) => finite(v.quality) > 0 && !!v.video_proxy_url)
        .sort((a, b) => finite(b.quality) - finite(a.quality));
      const variant = candidates.find((v) => finite(v.quality) <= maxQuality);
      if (!variant) {
        if (candidates.length === 0 && video.resource_proxy_url) {
          // Fallback to a complete, progressive file only when no quality variants were returned.
          return await this.downloadProgressive(video.resource_proxy_url, signal, onProgress, url);
        }
        throw new ApiError(422, `The requested YouTube quality (${maxQuality}p) is not available through the current provider.`);
      }

      dir = await fs.mkdtemp(path.join(this.options.tmpDir, 'dl-'));
      this.dirs.add(dir);
      const videoExt = safeExtension(variant.video_ext, 'mp4');
      const audioExt = safeExtension(variant.audio_ext, 'm4a');
      const videoPath = path.join(dir, `video.${videoExt}`);
      const total = { bytes: 0 };

      await this.downloadToFile(variant.video_proxy_url!, videoPath, signal, total, (fraction) => {
        onProgress?.({ status: 'downloading', ...(fraction === undefined ? {} : { percent: fraction * (variant.audio_proxy_url ? 75 : 94) }) });
      }, url);

      let finalPath = videoPath;
      let finalExt = videoExt;
      if (variant.audio_proxy_url) {
        const audioPath = path.join(dir, `audio.${audioExt}`);
        await this.downloadToFile(variant.audio_proxy_url, audioPath, signal, total, (fraction) => {
          onProgress?.({ status: 'downloading', ...(fraction === undefined ? {} : { percent: 75 + fraction * 19 }) });
        }, url);
        if (signal?.aborted) throw new ApiError(499, 'Request cancelled.');
        onProgress?.({ status: 'merging', percent: 97 });
        finalExt = videoExt === 'mp4' && audioExt === 'm4a' ? 'mp4' : 'mkv';
        finalPath = path.join(dir, `media.${finalExt}`);
        const merged = await this.runner.run(this.ffmpegBinary, [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-i', audioPath,
          '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', ...(finalExt === 'mp4' ? ['-movflags', '+faststart'] : []), finalPath,
        ], { timeoutMs: 120_000, signal });
        if (merged.aborted || signal?.aborted) throw new ApiError(499, 'Request cancelled.');
        if (merged.timedOut) throw new ApiError(504, 'Merging the YouTube video timed out.');
        if (merged.spawnFailed) throw new ApiError(500, 'Server setup problem: ffmpeg is missing.');
        if (merged.code !== 0) throw new ApiError(502, 'Could not merge the YouTube video and audio streams.');
      } else {
        const renamed = path.join(dir, `media.${finalExt}`);
        await fs.rename(videoPath, renamed);
        finalPath = renamed;
      }

      return { path: finalPath, dir, ext: finalExt };
    } catch (error) {
      await this.cleanupDir(dir);
      if (signal?.aborted) throw new ApiError(499, 'Request cancelled.');
      if (error instanceof ApiError && error.status === 410) this.proxyCache.delete(url);
      throw error;
    } finally {
      this.slots.release();
    }
  }

  async downloadAudio(rawUrl: string, fmt: 'mp3' | 'm4a', signal?: AbortSignal, onProgress?: ProgressReporter): Promise<DownloadedFile> {
    const url = rawUrl.trim();
    if (!this.isAllowed(url) || detectPlatform(url) !== 'youtube') throw new ApiError(400, 'Invalid or unsupported link.');
    if (fmt !== 'mp3' && fmt !== 'm4a') throw new ApiError(400, 'Unsupported audio format.');
    if (!(await this.slots.tryAcquire(5_000))) throw new ApiError(503, 'Server is busy. Please try again in a minute.');

    let dir: string | null = null;
    try {
      if (signal?.aborted) throw new ApiError(499, 'Request cancelled.');
      const { response } = await this.getCachedResponse(url, 'proxy');
      const audio = mediaOf(response, 'audio');
      const audioVariant = audio?.variants?.find((v) => v.audio_proxy_url) ?? audio?.variants?.[0];
      const sourceUrl = audio?.resource_proxy_url || audioVariant?.audio_proxy_url;
      if (!sourceUrl) throw new ApiError(422, 'No downloadable audio is available for this YouTube video.');

      dir = await fs.mkdtemp(path.join(this.options.tmpDir, 'dl-'));
      this.dirs.add(dir);
      const sourceExt = safeExtension(audioVariant?.audio_ext, 'm4a');
      const sourcePath = path.join(dir, `audio.${sourceExt}`);
      const total = { bytes: 0 };
      await this.downloadToFile(sourceUrl, sourcePath, signal, total, (fraction) => {
        onProgress?.({ status: 'downloading', ...(fraction === undefined ? {} : { percent: fraction * 90 }) });
      }, url);

      if (fmt === 'm4a' && sourceExt === 'm4a') {
        return { path: sourcePath, dir, ext: 'm4a' };
      }

      onProgress?.({ status: 'merging', percent: 96 });
      const finalPath = path.join(dir, `media.${fmt}`);
      const args = fmt === 'mp3'
        ? ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', finalPath]
        : ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, '-vn', '-c:a', 'aac', '-b:a', '192k', finalPath];
      const converted = await this.runner.run(this.ffmpegBinary, args, { timeoutMs: 120_000, signal });
      if (converted.aborted || signal?.aborted) throw new ApiError(499, 'Request cancelled.');
      if (converted.timedOut) throw new ApiError(504, 'Converting the YouTube audio timed out.');
      if (converted.spawnFailed) throw new ApiError(500, 'Server setup problem: ffmpeg is missing.');
      if (converted.code !== 0) throw new ApiError(502, 'Could not convert the YouTube audio.');
      return { path: finalPath, dir, ext: fmt };
    } catch (error) {
      await this.cleanupDir(dir);
      if (signal?.aborted) throw new ApiError(499, 'Request cancelled.');
      if (error instanceof ApiError && error.status === 410) this.proxyCache.delete(url);
      throw error;
    } finally {
      this.slots.release();
    }
  }

  async cleanup(file: DownloadedFile | null | undefined): Promise<void> {
    if (file) await this.cleanupDir(file.dir);
  }

  private async cleanupDir(dir: string | null): Promise<void> {
    if (!dir) return;
    this.dirs.delete(dir);
    await removeDir(dir);
  }

  private async getCachedResponse(url: string, kind: 'info' | 'proxy'): Promise<CachedResponse> {
    const key = url.trim();
    const cache = kind === 'info' ? this.infoCache : this.proxyCache;
    const inflight = kind === 'info' ? this.infoInflight : this.proxyInflight;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached;
    if (cached) cache.delete(key);

    const pending = inflight.get(key);
    if (pending) return pending;

    const request = this.extract(key, kind).finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
    inflight.set(key, request);
    return request;
  }

  private async extract(url: string, kind: 'info' | 'proxy'): Promise<CachedResponse> {
    let response: Response;
    const apiSignal = AbortSignal.timeout(this.options.apiTimeoutMs ?? 45_000);
    try {
      response = await this.fetcher(kind === 'info' ? INFO_API_URL : PROXY_API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url }),
        signal: apiSignal,
      });
    } catch {
      if (apiSignal.aborted) throw new ApiError(504, 'The YouTube processing service timed out. Please try again.');
      throw new ApiError(503, 'The YouTube processing service is temporarily unavailable. Please try again.');
    }

    const raw = await response.text();
    let payload: SnapAnyResponse & { error?: { code?: string; message?: string }; code?: string; message?: string; detail?: string };
    try { payload = JSON.parse(raw) as typeof payload; }
    catch { throw new ApiError(502, 'The YouTube processing service returned an unreadable response.'); }

    if (!response.ok) {
      const code = payload.error?.code || payload.code || '';
      if (response.status === 402 || code === 'insufficient_credits') throw new ApiError(503, 'The YouTube processing service is out of credits. Please try again later.');
      if (response.status === 401 || response.status === 403) throw new ApiError(500, 'The YouTube processing service rejected its API key. Please check the server configuration.');
      if (code === 'invalid_url') throw new ApiError(400, 'Invalid YouTube link.');
      if (code === 'unsupported_url' || code === 'unsupported_site') throw new ApiError(422, 'This YouTube URL type is not supported by the processing service.');
      if (code === 'age_restricted') throw new ApiError(422, 'This YouTube video is age-restricted and cannot be processed.');
      if (code === 'private_content' || code === 'members_only_content') throw new ApiError(422, 'This YouTube video is private or members-only.');
      if (code === 'content_deleted') throw new ApiError(404, 'This YouTube video was deleted or is unavailable.');
      if (code === 'region_restricted') throw new ApiError(422, 'This YouTube video is not available in the processing provider’s region.');
      if (code === 'live_stream_not_supported' || code === 'not_premiered') throw new ApiError(422, 'This YouTube video or live stream is not currently available for processing.');
      if (code === 'extract_failed' || code === 'retryable' || code === 'timeout' || code === 'unknown' || response.status === 429 || response.status >= 500) throw new ApiError(503, 'The YouTube processing service is temporarily busy. Please try again.');
      throw new ApiError(response.status === 422 ? 422 : 400, payload.error?.message || payload.message || payload.detail || 'The YouTube provider could not process this video.');
    }

    const info = toInfo(payload, url);
    const cached: CachedResponse = { response: payload, info, expires: Date.now() + (this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS) };
    const cache = kind === 'info' ? this.infoCache : this.proxyCache;
    this.pruneCache(cache);
    cache.set(url, cached);
    return cached;
  }

  private pruneCache(cache: Map<string, CachedResponse>): void {
    const now = Date.now();
    for (const [key, value] of cache) if (value.expires <= now) cache.delete(key);
    while (cache.size >= 100) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
    }
  }

  private async downloadProgressive(rawUrl: string, signal?: AbortSignal, onProgress?: ProgressReporter, cacheKey?: string): Promise<DownloadedFile> {
    let dir: string | null = null;
    try {
      dir = await fs.mkdtemp(path.join(this.options.tmpDir, 'dl-'));
      this.dirs.add(dir);
      const filePath = path.join(dir, 'media.mp4');
      await this.downloadToFile(rawUrl, filePath, signal, { bytes: 0 }, (fraction) => {
        onProgress?.({ status: 'downloading', ...(fraction === undefined ? {} : { percent: fraction * 95 }) });
      }, cacheKey);
      return { path: filePath, dir, ext: 'mp4' };
    } catch (error) {
      await this.cleanupDir(dir);
      if (signal?.aborted) throw new ApiError(499, 'Request cancelled.');
      if (error instanceof ApiError && error.status === 410 && cacheKey) this.proxyCache.delete(cacheKey);
      throw error;
    }
  }

  private async downloadToFile(
    rawUrl: string,
    destination: string,
    signal: AbortSignal | undefined,
    total: { bytes: number },
    report: (fraction: number | undefined) => void,
    cacheKey?: string,
  ): Promise<void> {
    const timeout = AbortSignal.timeout(this.options.downloadTimeoutMs ?? 300_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let url = safeHttpsUrl(rawUrl);
    let response: Response | undefined;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      try {
        response = await this.fetcher(url, { method: 'GET', signal: combinedSignal, redirect: 'manual' });
      } catch {
        if (signal?.aborted) throw new ApiError(499, 'Request cancelled.');
        if (combinedSignal.aborted) throw new ApiError(504, 'The YouTube proxy download timed out.');
        throw new ApiError(503, 'The YouTube proxy is temporarily unavailable. Please try again.');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === MAX_REDIRECTS) throw new ApiError(502, 'The YouTube proxy returned an invalid redirect.');
        await response.body?.cancel().catch(() => undefined);
        url = safeHttpsUrl(new URL(location, url).toString());
        continue;
      }
      break;
    }

    if (!response?.ok || !response.body) {
      const text = response ? (await response.text()).slice(0, 1000) : '';
      if (response?.status === 404 || /payload_expired/i.test(text)) {
        if (cacheKey) this.proxyCache.delete(cacheKey);
        throw new ApiError(410, 'The YouTube download link expired. Please try again.');
      }
      if (response?.status === 403) {
        if (cacheKey) this.proxyCache.delete(cacheKey);
        throw new ApiError(502, 'The YouTube proxy could not deliver this video. Please retry.');
      }
      throw new ApiError(502, `The YouTube proxy download failed${response ? ` (HTTP ${response.status})` : ''}.`);
    }

    const declared = finite(response.headers.get('content-length'));
    if (declared > 0 && (declared > this.maxBytes || total.bytes + declared > this.maxBytes)) {
      throw new ApiError(413, 'This file is too large to download here.');
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json') || contentType.includes('text/html')) {
      const text = (await response.text()).slice(0, 1000);
      if (/payload_expired/i.test(text)) {
        if (cacheKey) this.proxyCache.delete(cacheKey);
        throw new ApiError(410, 'The YouTube download link expired. Please try again.');
      }
      throw new ApiError(502, 'The YouTube proxy returned an error instead of media.');
    }

    let received = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length;
        total.bytes += chunk.length;
        if (received > this.maxBytes || total.bytes > this.maxBytes) return callback(new ApiError(413, 'This file is too large to download here.'));
        if (declared > 0) report(Math.min(1, received / declared));
        else report(undefined);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        meter,
        createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
        { signal: combinedSignal },
      );
      if (received === 0) throw new ApiError(502, 'The YouTube proxy returned an empty media file.');
    } catch (error) {
      await fs.rm(destination, { force: true });
      if (signal?.aborted) throw new ApiError(499, 'Request cancelled.');
      if (combinedSignal.aborted) throw new ApiError(504, 'The YouTube proxy download timed out.');
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'Could not save the media received from the YouTube proxy.');
    }
  }
}
