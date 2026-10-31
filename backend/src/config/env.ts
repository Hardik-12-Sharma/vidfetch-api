import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
const boolTrue = z.enum(['true', 'false']).default('true').transform((v) => v === 'true');
const PLACEHOLDER_SECRET = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING_32_PLUS';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  TRUST_PROXY: bool,
  YTDLP_PATH: z.string().default('yt-dlp'),
  YTDLP_FFMPEG_LOCATION: z.string().optional().transform((v) => v || undefined),
  YTDLP_YT_CLIENTS: z.string().regex(/^[a-z0-9_,]+$/i, 'e.g. default or default,mweb').default('default'),
  YTDLP_INFO_CLIENTS: z.string().regex(/^[a-z0-9_,]*$/i, 'e.g. android_vr').default('').transform((v) => v || undefined),
  YTDLP_CACHE_DIR: z.string().optional().transform((v) => v || undefined),
  YTDLP_WARMUP: boolTrue,
  YTDLP_REUSE_INFO: boolTrue,
  YTDLP_ARIA2C: bool,
  YTDLP_COOKIES_FILE: z.string().optional().transform((v) => v || undefined),
  YTDLP_COOKIES_FROM_BROWSER: z.string().regex(/^[a-z0-9_.:+ \/-]*$/i, 'e.g. chrome or firefox').optional().transform((v) => v || undefined),
  YTDLP_MAX_CONCURRENT: z.coerce.number().int().min(1).max(32).default(3),
  YTDLP_MAX_FILESIZE: z.string().regex(/^\d+[KMGkmg]?$/, 'e.g. 500M or 2G').default('2G'),
  TMP_DIR: z.string().default(path.join(os.tmpdir(), 'vidfetch')),
  DATA_DIR: z.string().default('./data'),
  RATE_LIMIT_INFO_PER_MINUTE: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_DOWNLOAD_PER_MINUTE: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_ORDER_PER_MINUTE: z.coerce.number().int().positive().default(10),
  FREE_MAX_QUALITY: z.coerce.number().int().min(144).max(4320).default(4320),
  RAZORPAY_KEY_ID: z.string().default('rzp_test_xxxxxxxx'),
  RAZORPAY_KEY_SECRET: z.string().default('change_me'),
  PREMIUM_TOKEN_SECRET: z.string().default(PLACEHOLDER_SECRET),
  PREMIUM_PRICE_PAISE: z.coerce.number().int().positive().default(1900),
  PREMIUM_DAYS: z.coerce.number().int().positive().default(30),
}).superRefine((e, ctx) => {
  if (e.NODE_ENV === 'production' && (e.PREMIUM_TOKEN_SECRET.length < 32 || e.PREMIUM_TOKEN_SECRET.startsWith('CHANGE_ME'))) {
    ctx.addIssue({ code: 'custom', path: ['PREMIUM_TOKEN_SECRET'], message: 'must be a random string of at least 32 characters in production' });
  }
});

export type Config = z.infer<typeof Env>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);
export const corsOrigins = (c: Config) => c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
