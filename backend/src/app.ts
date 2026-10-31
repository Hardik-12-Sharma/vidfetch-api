import path from 'node:path';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { corsOrigins, type Config } from './config/env.js';
import { createMediaController } from './controllers/media.controller.js';
import { createPremiumController } from './controllers/premium.controller.js';
import { registerErrorHandling } from './plugins/errorHandler.js';
import { registerRateLimit } from './plugins/rateLimit.js';
import { mediaRoutes } from './routes/media.routes.js';
import { premiumRoutes } from './routes/premium.routes.js';
import { JobService } from './services/jobs.service.js';
import { PremiumService } from './services/premium.service.js';
import { YtDlpService } from './services/ytdlp.service.js';

export interface AppDeps { ytdlp?: YtDlpService; premium?: PremiumService }

export async function buildApp(config: Config, deps: AppDeps = {}) {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 16 * 1024,
    logger: config.NODE_ENV === 'test' ? false : {
      level: 'info',
      // Never log query strings (they contain media URLs and premium tokens) or credentials.
      serializers: { req: (r) => ({ method: r.method, url: r.url.split('?')[0] }) },
      redact: ['req.headers.authorization', 'req.headers["x-premium-token"]', 'req.headers.cookie'],
    },
  });

  // Tolerate empty bodies on JSON POSTs (e.g. POST /api/premium/order with Content-Type but no body).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch { const e: any = new Error('Invalid JSON'); e.statusCode = 400; done(e); }
  });

  // CORS first, so even 429 responses carry CORS headers (same reason the Java version used an interceptor).
  await app.register(cors, { origin: corsOrigins(config), methods: ['GET', 'POST', 'OPTIONS'], exposedHeaders: ['Content-Disposition'], maxAge: 3600 });
  registerRateLimit(app, { info: config.RATE_LIMIT_INFO_PER_MINUTE, download: config.RATE_LIMIT_DOWNLOAD_PER_MINUTE, order: config.RATE_LIMIT_ORDER_PER_MINUTE });
  registerErrorHandling(app);

  const ytdlp = deps.ytdlp ?? new YtDlpService({
    binary: config.YTDLP_PATH, ffmpegLocation: config.YTDLP_FFMPEG_LOCATION, maxConcurrent: config.YTDLP_MAX_CONCURRENT,
    maxFilesize: config.YTDLP_MAX_FILESIZE, tmpDir: config.TMP_DIR,
    ytClients: config.YTDLP_YT_CLIENTS, infoClients: config.YTDLP_INFO_CLIENTS, cacheDir: config.YTDLP_CACHE_DIR, warmup: config.YTDLP_WARMUP,
    reuseInfo: config.YTDLP_REUSE_INFO, aria2c: config.YTDLP_ARIA2C,
    cookiesFile: config.YTDLP_COOKIES_FILE, cookiesFromBrowser: config.YTDLP_COOKIES_FROM_BROWSER,
  });
  const premium = deps.premium ?? new PremiumService({
    keyId: config.RAZORPAY_KEY_ID, keySecret: config.RAZORPAY_KEY_SECRET, tokenSecret: config.PREMIUM_TOKEN_SECRET,
    pricePaise: config.PREMIUM_PRICE_PAISE, days: config.PREMIUM_DAYS, storePath: path.join(config.DATA_DIR, 'premium-payments.json'),
  });
  await ytdlp.init();
  await premium.init();
  const jobs = new JobService((f) => ytdlp.cleanup(f));
  app.addHook('onClose', async () => { await jobs.close(); await ytdlp.close(); });

  app.get('/api/health', async () => ({ success: true, status: 'ok' }));
  mediaRoutes(app, createMediaController({ ytdlp, premium, jobs, freeMaxQuality: config.FREE_MAX_QUALITY }));
  premiumRoutes(app, createPremiumController(premium));
  return app;
}
