import { ApiError } from './apiError.js';

/** Port of MediaController.parseQuality. `best` maps to freeMax (the original FREE_MAX_QUALITY). */
export function parseQuality(input: string | undefined, freeMax: number): number {
  let v = (input ?? '').trim().toLowerCase();
  if (v === 'best') return freeMax;
  if (v === '4k') return 2160;
  if (v.endsWith('p')) v = v.slice(0, -1);
  if (/^\d{3,4}$/.test(v)) {
    const n = Number(v);
    if (n >= 100 && n <= 4320) return n;
  }
  throw new ApiError(400, 'Invalid quality.');
}

export const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};
export const contentTypeFor = (ext: string) => CONTENT_TYPES[ext] ?? 'application/octet-stream';
