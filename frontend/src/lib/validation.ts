export const INSTA_RE = /^https?:\/\/(www\.)?instagram\.com\/(reel|reels|p|tv|stories)\/[^/?#]+/i;
export const YT_RE = /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch|shorts)|youtu\.be\/).+/i;

/** The backend only accepts https links: upgrade http and trim spaces. */
export const fixUrl = (v: string | null | undefined): string => (v || '').trim().replace(/^http:\/\//i, 'https://');

export function ytId(url: string): string | null {
  const m = /(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/.exec(url);
  return m ? m[1]! : null;
}

export function instaPreviewUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)instagram\.com$/i.test(parsed.hostname)) return null;   // exact domain or subdomain (original also matched evilinstagram.com)
    const match = parsed.pathname.match(/^\/(reel|reels|p|tv)\/([^/]+)/i);
    if (!match) return null;
    const type = match[1]!.toLowerCase() === 'reels' ? 'reel' : match[1]!.toLowerCase();
    return `https://www.instagram.com/${type}/${match[2]}/embed/`;
  } catch {
    return null;
  }
}

/** One search box for both platforms. */
export const FB_RE = /^https?:\/\/(?:www\.|m\.|web\.|mbasic\.)?(?:facebook\.com\/(?:watch|reel|reels|share|video\.php|video|videos|story\.php|permalink\.php|[^/?#]+\/(?:videos|posts|reel))|fb\.watch\/)/i;
// X (Twitter) post links (the backend re-checks every link strictly).
export const X_RE = /^https?:\/\/(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com\/(?:i\/web|[A-Za-z0-9_]{1,15})\/status(?:es)?\/\d+/i;
export const isSupportedLink = (u: string): boolean => INSTA_RE.test(u) || YT_RE.test(u) || FB_RE.test(u) || X_RE.test(u);

/** Tweet id from an X / Twitter post link (/user/status/123, /i/web/status/123 ...). */
export function xId(url: string): string | null {
  const m = /\/status(?:es)?\/(\d{1,25})/.exec(url);
  return m ? m[1]! : null;
}

/** X's own embed page: shows the post (and its video) straight away, with no backend call. */
export function xPreviewUrl(url: string): string | null {
  if (!X_RE.test(url)) return null;
  const id = xId(url);
  return id ? `https://platform.twitter.com/embed/Tweet.html?id=${id}&theme=dark&dnt=true&hideThread=true&lang=en` : null;
}
