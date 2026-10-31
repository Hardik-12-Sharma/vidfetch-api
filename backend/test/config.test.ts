import { describe, expect, it } from 'vitest';
import { corsOrigins, loadConfig } from '../src/config/env.js';

describe('environment validation', () => {
  it('applies the original defaults', () => {
    const c = loadConfig({} as any);
    expect(c.PORT).toBe(4000); expect(c.PREMIUM_PRICE_PAISE).toBe(1900); expect(c.PREMIUM_DAYS).toBe(30);
    expect(c.RATE_LIMIT_INFO_PER_MINUTE).toBe(30); expect(c.RATE_LIMIT_DOWNLOAD_PER_MINUTE).toBe(5); expect(c.RATE_LIMIT_ORDER_PER_MINUTE).toBe(10);
    expect(c.YTDLP_MAX_CONCURRENT).toBe(3); expect(c.YTDLP_MAX_FILESIZE).toBe('2G'); expect(c.FREE_MAX_QUALITY).toBe(4320);
  });
  it('refuses to boot in production with a placeholder or short token secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as any)).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'production', PREMIUM_TOKEN_SECRET: 'short' } as any)).toThrow();
    expect(loadConfig({ NODE_ENV: 'production', PREMIUM_TOKEN_SECRET: 'z'.repeat(40) } as any).NODE_ENV).toBe('production');
  });
  it('rejects malformed values', () => {
    expect(() => loadConfig({ PORT: 'abc' } as any)).toThrow();
    expect(() => loadConfig({ YTDLP_MAX_FILESIZE: '2 gigs; rm' } as any)).toThrow();
  });
  it('parses the CORS allow-list', () => {
    expect(corsOrigins(loadConfig({ CORS_ORIGINS: 'http://a.test, https://b.test ,' } as any))).toEqual(['http://a.test', 'https://b.test']);
  });
});
