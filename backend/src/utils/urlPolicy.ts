// Ported 1:1 from YtDlpService.ALLOWED_URL. Only https links to these exact YouTube/Instagram
// paths are accepted, so arbitrary hosts (SSRF) and non-https schemes can never reach yt-dlp.
const ALLOWED_URL = new RegExp(
  '^https://(?:www\\.|m\\.)?(?:' +
    'instagram\\.com/(?:reel|reels|p|tv)/[A-Za-z0-9_-]+/?' +
    '|instagram\\.com/stories/[A-Za-z0-9_.]+/[0-9]+/?' +
    '|youtube\\.com/watch\\?v=[A-Za-z0-9_-]{11}' +
    '|youtube\\.com/shorts/[A-Za-z0-9_-]{11}' +
    '|youtu\\.be/[A-Za-z0-9_-]{11}' +
    ')(?:[?&#][A-Za-z0-9_=&%.~-]*)?$',
  'i',
);
const INSTAGRAM_URL = /^https:\/\/(?:www\.|m\.)?instagram\.com\//i;

const FACEBOOK_URL = /^https:\/\/(?:(?:www\.|m\.)?facebook\.com|fb\.watch)\//i;

export type Platform = 'instagram' | 'youtube' | 'facebook' | 'x';

const FACEBOOK_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'fb.watch',
]);

function isAllowedFacebookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname;

    // Only allow HTTPS and explicitly supported Facebook domains.
    if (
      url.protocol !== 'https:' ||
      !FACEBOOK_HOSTS.has(hostname) ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    ) {
      return false;
    }

    // Short Facebook watch links.
    if (hostname === 'fb.watch') {
      return /^\/[A-Za-z0-9_-]+\/?$/.test(pathname);
    }

    // Facebook watch and video.php links require a numeric video ID.
    if (/^\/(?:watch|video\.php)\/?$/i.test(pathname)) {
      return /^\d{6,25}$/.test(url.searchParams.get('v') ?? '');
    }

    // Reel and video links.
    if (
      /^\/(?:reel|reels|video|videos)\/[A-Za-z0-9_-]+\/?$/i.test(pathname)
    ) {
      return true;
    }

    // Facebook shared video/reel links.
    if (/^\/share\/[vr]\/[A-Za-z0-9_-]+\/?$/i.test(pathname)) {
      return true;
    }

    // Page-specific videos, posts, and reels.
    if (
      /^\/[A-Za-z0-9.-]+\/(?:videos|posts|reel)\/[A-Za-z0-9_-]+\/?$/i.test(
        pathname,
      )
    ) {
      return true;
    }

    // Facebook story and permalink links.
    if (/^\/(?:story|permalink)\.php$/i.test(pathname)) {
      const id =
        url.searchParams.get('story_fbid') ??
        url.searchParams.get('fbid');

      return /^\d{6,25}$/.test(id ?? '');
    }

    return false;
  } catch {
    return false;
  }
}
const FACEBOOK_RAW = /^https:\/\/(?:(?:www\.|m\.|web\.|mbasic\.)?facebook\.com|fb\.watch)\//i;

// X (Twitter) posts. Same rule as the others: https only, exact hosts, known paths only.
// X: x.com / twitter.com /<user>/status/<id> (also /i/status/<id>, /i/web/status/<id>, optional /video/1 or /photo/1).
const X_ALLOWED = /^https:\/\/(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com\/(?:i\/web|[A-Za-z0-9_]{1,15})\/status(?:es)?\/[0-9]{1,25}(?:\/(?:video|photo)\/[0-9]{1,2})?\/?(?:[?#][A-Za-z0-9_=&%.~-]*)?$/i;
const X_URL = /^https:\/\/(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com\//i;
/** Facebook share links carry long tracking params: keep only what the video needs (v=ID for /watch and video.php). */
export function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!FACEBOOK_RAW.test(t)) return t;
  try {
    const x = new URL(t);
    const keepV = /^\/(?:watch|video\.php)(?:\/|$)/i.test(x.pathname) && x.searchParams.get('v');
    x.hostname = x.hostname.replace(/^(?:web|mbasic)\./i, 'www.');
    x.hash = ''; x.search = keepV ? `?v=${encodeURIComponent(keepV)}` : '';
    return x.toString();
  } catch { return t; }
}

export function isAllowedUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 300) return false;

  const t = url.trim();

  return (
    ALLOWED_URL.test(t) ||
    isAllowedFacebookUrl(t) ||
    X_ALLOWED.test(t)
  );
}
export const detectPlatform = (url: string): Platform => (INSTAGRAM_URL.test(url.trim()) ? 'instagram' : FACEBOOK_URL.test(url.trim()) ? 'facebook' : X_URL.test(url.trim()) ? 'x' : 'youtube');
