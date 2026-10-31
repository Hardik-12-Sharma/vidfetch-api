import { z } from 'zod';

const optionalText = (max: number) => z.string().max(max).optional();
/** `url` may come from the query string or JSON body (the original accepted ?url= on GET and POST). */
export const InfoInput = z.object({ url: z.string().max(2048) });
export const DownloadQuery = z.object({
  url: z.string().max(2048),
  quality: optionalText(16).default('720p'),
  audio: optionalText(8),
  token: optionalText(300),
});
export const AudioFormat = z.enum(['mp3', 'm4a']);
export type DownloadQueryT = z.infer<typeof DownloadQuery>;
