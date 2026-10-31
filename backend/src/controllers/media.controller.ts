import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DownloadQuery, InfoInput, AudioFormat } from '../schemas/media.schema.js';
import type { JobService } from '../services/jobs.service.js';
import type { PremiumService } from '../services/premium.service.js';
import type { YtDlpService } from '../services/ytdlp.service.js';
import type { SnapAnyService } from '../services/snapany.service.js';
import { ApiError } from '../utils/apiError.js';
import { detectPlatform, normalizeUrl } from '../utils/urlPolicy.js';
import { contentTypeFor, parseQuality } from '../utils/quality.js';

export interface MediaDeps { ytdlp: YtDlpService; snapany?: SnapAnyService; premium: PremiumService; jobs: JobService; freeMaxQuality: number }
// Rough MB estimate (kbps by resolution) when the site does not report a file size.
const KBPS = [[2160, 12000], [1440, 6000], [1080, 3000], [720, 1500], [480, 800], [360, 500], [240, 200], [0, 100]] as const;
const estimateSize = (q: number, secs: number) => (secs > 0 ? Math.floor((KBPS.find(([h]) => q >= h)![1]) * secs * 125) : 0);
const INVALID_LINK = 'Invalid or unsupported link.';

export function createMediaController({ ytdlp, snapany, premium, jobs, freeMaxQuality }: MediaDeps) {
  // Keep yt-dlp for Instagram/Facebook/X. Use the managed proxy provider only for YouTube when configured.
  const providerFor = (url: string) => detectPlatform(url) === 'youtube' && snapany ? snapany : ytdlp;

  return {
    async info(req: FastifyRequest) {
      const url = normalizeUrl(InfoInput.parse({ ...(req.query as object), ...((req.body as object | undefined) ?? {}) }).url);
      if (!ytdlp.isAllowed(url)) throw new ApiError(400, INVALID_LINK);
      const info = await providerFor(url).fetchInfo(url.trim());
      return {
        success: true,
        platform: info.platform,
        title: info.title,
        thumbnail: info.thumbnail,
        freeMaxQuality,
        audioSize: info.audioSize,
        mp3Size: Math.floor(info.duration * 245 * 125),
        formats: info.qualities.filter((q) => q.quality >= 144).map((q) => ({
          quality: `${q.quality}p`, value: q.quality, locked: q.quality > freeMaxQuality, size: q.size || estimateSize(q.quality, info.duration),
        })),
      };
    },

    /** Step 1 of the progress flow: validate, start the download in the background, return a job id. */
    async prepare(req: FastifyRequest) {
      const q = DownloadQuery.parse(req.query);
      const link = normalizeUrl(q.url);
      if (!ytdlp.isAllowed(link)) throw new ApiError(400, INVALID_LINK);
      const provider = providerFor(link);
      if (q.audio && q.audio.trim()) {
        const fmt = AudioFormat.safeParse(q.audio.trim().toLowerCase());
        if (!fmt.success) throw new ApiError(400, 'Invalid audio format.');
        return { success: true, jobId: jobs.start((report, signal) => provider.downloadAudio(link, fmt.data, signal, report), (file) => provider.cleanup(file)) };
      }
      const quality = parseQuality(q.quality, freeMaxQuality);
      const token = q.token ?? (req.headers['x-premium-token'] as string | undefined);
      if (quality > freeMaxQuality && !premium.isValid(token)) throw new ApiError(402, 'This quality needs Premium.');
      return { success: true, jobId: jobs.start((report, signal) => provider.download(link, quality, signal, report), (file) => provider.cleanup(file)) };
    },

    /** Step 2: the browser polls this for status + percent. */
    async progress(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      reply.header('Cache-Control', 'no-store');
      return { success: true, ...jobs.view(id) };
    },

    /** Step 3: the browser downloads the finished file directly (native download, progress shown by the browser). */
    async file(req: FastifyRequest, reply: FastifyReply) {
      const { id } = req.params as { id: string };
      const file = jobs.file(id);
      try {
        const size = (await fs.stat(file.path)).size;
        reply.header('Content-Type', contentTypeFor(file.ext))
          .header('Content-Length', size)
          .header('Content-Disposition', `attachment; filename="download.${file.ext}"`)
          .header('Cache-Control', 'no-store');
        reply.raw.once('close', () => jobs.served(id));
        return reply.send(createReadStream(file.path));
      } catch (e) {
        jobs.served(id);
        throw new ApiError(404, 'This download expired. Please try again.');
      }
    },

    async download(req: FastifyRequest, reply: FastifyReply) {
      const q = DownloadQuery.parse(req.query);
      const link = normalizeUrl(q.url);
      if (!ytdlp.isAllowed(link)) throw new ApiError(400, INVALID_LINK);
      const provider = providerFor(link);

      // Client went away before the file was ready => cancel provider work instead of finishing uselessly.
      const ac = new AbortController();
      reply.raw.once('close', () => { if (!reply.raw.writableFinished) ac.abort(); });

      let file;
      if (q.audio && q.audio.trim()) {
        const fmt = AudioFormat.safeParse(q.audio.trim().toLowerCase());
        if (!fmt.success) throw new ApiError(400, 'Invalid audio format.');
        file = await provider.downloadAudio(link, fmt.data, ac.signal);
      } else {
        const quality = parseQuality(q.quality, freeMaxQuality);
        const token = q.token ?? (req.headers['x-premium-token'] as string | undefined);
        if (quality > freeMaxQuality && !premium.isValid(token)) throw new ApiError(402, 'This quality needs Premium.');
        file = await provider.download(link, quality, ac.signal);
      }

      try {
        const size = (await fs.stat(file.path)).size;
        reply.header('Content-Type', contentTypeFor(file.ext))
          .header('Content-Length', size)
          .header('Content-Disposition', `attachment; filename="download.${file.ext}"`)
          .header('Cache-Control', 'no-store');
        reply.raw.once('close', () => void provider.cleanup(file));   // after finish OR client abort
        return reply.send(createReadStream(file.path));
      } catch (e) {
        await provider.cleanup(file);
        throw e;
      }
    },
  };
}
