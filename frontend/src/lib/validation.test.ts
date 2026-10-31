import { describe, expect, it } from 'vitest';
import { fixUrl, instaPreviewUrl, INSTA_RE, YT_RE, ytId } from './validation';

describe('platform URL patterns (unchanged from the Vite app)', () => {
  it.each([
    'https://www.instagram.com/reel/Cabc123/', 'https://instagram.com/p/abc', 'http://www.instagram.com/tv/abc/?igsh=1', 'https://www.instagram.com/stories/user/123',
  ])('INSTA accepts %s', (u) => expect(INSTA_RE.test(u)).toBe(true));
  it.each(['https://www.instagram.com/', 'https://example.com/reel/abc', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'instagram.com/reel/abc'])('INSTA rejects %s', (u) =>
    expect(INSTA_RE.test(u)).toBe(false));
  it.each(['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ'])('YT accepts %s', (u) =>
    expect(YT_RE.test(u)).toBe(true));
  it.each(['https://www.youtube.com/', 'https://vimeo.com/123', 'https://www.instagram.com/reel/abc'])('YT rejects %s', (u) => expect(YT_RE.test(u)).toBe(false));
});

describe('fixUrl', () => {
  it('trims and upgrades http to https', () => {
    expect(fixUrl('  http://youtu.be/dQw4w9WgXcQ ')).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(fixUrl('https://x.test')).toBe('https://x.test');
    expect(fixUrl(null)).toBe('');
  });
});

describe('previews', () => {
  it('extracts a YouTube id from watch, short and shorts links', () => {
    expect(ytId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5')).toBe('dQw4w9WgXcQ');
    expect(ytId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(ytId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(ytId('https://example.com')).toBeNull();
  });
  it('builds the Instagram embed URL (reels => reel) and rejects other hosts', () => {
    expect(instaPreviewUrl('https://www.instagram.com/reels/Cabc/?x=1')).toBe('https://www.instagram.com/reel/Cabc/embed/');
    expect(instaPreviewUrl('https://instagram.com/p/Cabc/')).toBe('https://www.instagram.com/p/Cabc/embed/');
    expect(instaPreviewUrl('https://evilinstagram.com/p/Cabc/')).toBeNull();
    expect(instaPreviewUrl('not a url')).toBeNull();
  });
});

import { FB_RE } from './validation';

describe('FB_RE', () => {
  it.each(['https://www.facebook.com/reel/123456', 'https://www.facebook.com/watch/?v=123', 'https://fb.watch/abc/', 'https://www.facebook.com/page/videos/123/'])('accepts %s', (u) => expect(FB_RE.test(u)).toBe(true));
  it.each(['https://www.facebook.com/', 'https://example.com/reel/123', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'])('rejects %s', (u) => expect(FB_RE.test(u)).toBe(false));
});

import { isSupportedLink, X_RE } from './validation';

describe('X links', () => {
  it.each(['https://x.com/someuser/status/1850000000000000000', 'https://twitter.com/someuser/status/123456789?s=20', 'http://mobile.twitter.com/someuser/status/123456789', 'https://x.com/i/web/status/123456789'])('X accepts %s', (u) =>
    expect(X_RE.test(u)).toBe(true));
  it.each(['https://x.com/home', 'https://x.com/someuser', 'https://example.com/someuser/status/123456789', 'https://fakex.com/someuser/status/123456789'])('X rejects %s', (u) =>
    expect(X_RE.test(u)).toBe(false));
  it('the search box accepts X links and still rejects unsupported sites (Reddit included)', () => {
    expect(isSupportedLink('https://x.com/someuser/status/123456789')).toBe(true);
    expect(isSupportedLink('https://www.reddit.com/r/videos/comments/6rrwyj/title/')).toBe(false);   // Reddit is no longer supported
    expect(isSupportedLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isSupportedLink('https://vimeo.com/123')).toBe(false);
  });
  it('X links never look like a YouTube link to the preview code', () => {
    for (const u of ['https://x.com/someuser/status/1850000000000000000?s=20&t=abc']) expect(ytId(u)).toBeNull();
  });
});

import { xPreviewUrl } from './validation';

describe('instant preview for X', () => {
  it('X: embeds the post by id for every host variant, nothing for non-post links', () => {
    const embed = (id: string) => `https://platform.twitter.com/embed/Tweet.html?id=${id}&theme=dark&dnt=true&hideThread=true&lang=en`;
    expect(xPreviewUrl('https://x.com/someuser/status/1850000000000000000?s=20&t=abc')).toBe(embed('1850000000000000000'));
    expect(xPreviewUrl('https://twitter.com/someuser/status/123456789')).toBe(embed('123456789'));
    expect(xPreviewUrl('https://x.com/i/web/status/123456789')).toBe(embed('123456789'));
    for (const u of ['https://x.com/home', 'https://x.com/someuser', 'https://evil.com/someuser/status/123456789']) expect(xPreviewUrl(u)).toBeNull();
  });
});
