import { describe, expect, it } from 'vitest';
import { detectPlatform, isAllowedUrl } from '../src/utils/urlPolicy.js';
import { parseQuality } from '../src/utils/quality.js';
import { ApiError } from '../src/utils/apiError.js';

describe('isAllowedUrl', () => {
  const ok = [
    'https://www.instagram.com/reel/Cabc123_-x/', 'https://instagram.com/p/abc/', 'https://www.instagram.com/tv/abc',
    'https://www.instagram.com/stories/some.user/1234567890/', 'https://m.instagram.com/reels/abc/?igsh=xyz%3D',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=dQw4w9WgXcQ&t=10s',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://www.facebook.com/reel/123456789012345', 'https://www.facebook.com/watch/?v=123456789', 'https://m.facebook.com/watch?v=123456789',
    'https://www.facebook.com/somepage/videos/123456789/', 'https://www.facebook.com/share/v/1AbCdEf/', 'https://www.facebook.com/share/r/1AbCdEf/', 'https://fb.watch/abcDEF_1/',
    'https://www.facebook.com/watch?v=123456789',
    'https://www.facebook.com/video.php?v=123456789',
    'https://www.facebook.com/somepage/posts/123456789',
    'https://www.facebook.com/somepage/reel/123456789',
    'https://www.facebook.com/story.php?story_fbid=123456789',
  ];
  const bad = [
    'https://www.facebook.com/watch/?v=abc',
    'https://www.facebook.com/watch/?v=123',
    'https://www.facebook.com/watch/?v=123456789/extra',
    'https://www.facebook.com/watch/extra?v=123456789',
    'https://www.facebook.com/reel/',
    'https://www.facebook.com/share/invalid/123456',
    'https://www.facebook.com.evil.com/reel/123456789',
    'https://evil.com/watch?v=123456789',
    'http://www.facebook.com/reel/123456789',
    'https://www.facebook.com:8443/reel/123456789',
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://evil.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQQ', 'https://www.youtube.com/playlist?list=PL123',
    'https://www.instagram.com/accounts/login/', 'https://www.facebook.com/login/', 'https://facebook.com.evil.com/reel/123', 'https://www.facebook.com/watch/?v=abc', 'https://localhost/x', 'https://169.254.169.254/latest/meta-data',
    'file:///etc/passwd', 'javascript:alert(1)', '--exec=rm -rf /', 'https://youtu.be/dQw4w9WgXcQ;rm -rf /',
    'https://youtu.be/dQw4w9WgXcQ\nhttps://evil.com', '', ' ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' + '&a=b'.repeat(100),
  ];
  it.each(ok)('accepts %s', (u) => expect(isAllowedUrl(u)).toBe(true));
  it.each(bad)('rejects %j', (u) => expect(isAllowedUrl(u)).toBe(false));
  it('rejects non-strings', () => { expect(isAllowedUrl(undefined)).toBe(false); expect(isAllowedUrl(42)).toBe(false); });
});

describe('detectPlatform', () => {
  it('detects instagram vs youtube', () => {
    expect(detectPlatform('https://www.instagram.com/reel/abc/')).toBe('instagram');
    expect(detectPlatform('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
  });
});

describe('parseQuality', () => {
  it('parses the original accepted forms', () => {
    expect(parseQuality('720p', 4320)).toBe(720);
    expect(parseQuality('1080', 4320)).toBe(1080);
    expect(parseQuality(' 4K ', 4320)).toBe(2160);
    expect(parseQuality('best', 4320)).toBe(4320);
    expect(parseQuality('best', 1080)).toBe(1080);
  });
  it.each(['', 'abc', '99p', '4321', '-1', '720p; rm -rf', '1e3', '0x400'])('rejects %j', (q) => {
    try { parseQuality(q, 4320); throw new Error('should have thrown'); } catch (e) {
      expect(e).toBeInstanceOf(ApiError); expect((e as ApiError).status).toBe(400);
    }
  });
});

describe('detectPlatform facebook', () => {
  it('detects facebook links', () => {
    expect(detectPlatform('https://www.facebook.com/reel/123456789')).toBe('facebook');
    expect(detectPlatform('https://fb.watch/abcDEF_1/')).toBe('facebook');
    expect(detectPlatform('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
  });
});

describe('X (Twitter) links', () => {
  const ok = [
    'https://x.com/someuser/status/1850000000000000000', 'https://twitter.com/some_user/status/1850000000000000000?s=20&t=AbC-dEf_gH',
    'https://www.x.com/i/status/1850000000000000000', 'https://x.com/i/web/status/1850000000000000000', 'https://mobile.twitter.com/someuser/status/123456789',
    'https://x.com/someuser/status/1850000000000000000/video/1',
  ];
  const bad = [
    'http://x.com/someuser/status/123456789', 'https://x.com/someuser', 'https://x.com/home', 'https://x.com/someuser/status/abc',
    'https://x.com.evil.com/someuser/status/123456789', 'https://evilx.com/someuser/status/123456789', 'https://x.com@evil.com/someuser/status/123456789', 'https://t.co/AbCdEfGh',
    'https://www.reddit.com/r/videos/comments/6rrwyj/that_small_heart_attack/', 'https://redd.it/6rrwyj',   // Reddit is no longer supported
  ];
  it.each(ok)('accepts %s', (u) => expect(isAllowedUrl(u)).toBe(true));
  it.each(bad)('rejects %j', (u) => expect(isAllowedUrl(u)).toBe(false));
  it('detects x and leaves the other platforms alone', () => {
    expect(detectPlatform('https://x.com/someuser/status/123456789')).toBe('x');
    expect(detectPlatform('https://twitter.com/someuser/status/123456789')).toBe('x');
    expect(detectPlatform('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
    expect(detectPlatform('https://www.instagram.com/reel/abc/')).toBe('instagram');
    expect(detectPlatform('https://www.facebook.com/reel/123456789')).toBe('facebook');
  });
});
