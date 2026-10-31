import type { ApiErrorBody, AudioFormat, MediaInfo } from '@/types/api';
import { API_URL } from './env';

export class ApiRequestError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'ApiRequestError'; }
}
export const NETWORK_ERROR = 'Cannot reach the server. Is the backend running?';

/** Turns thrown errors into the message shown to the user (same wording as the original app). */
export const errorMessage = (e: unknown): string =>
  e instanceof TypeError ? NETWORK_ERROR : e instanceof Error ? e.message : 'Something went wrong.';

export async function fetchMediaInfo(url: string, signal?: AbortSignal): Promise<MediaInfo> {
  const res = await fetch(`${API_URL}/api/media/info?url=${encodeURIComponent(url)}`, { method: 'POST', signal });
  let data: MediaInfo | ApiErrorBody;
  try { data = await res.json(); } catch { throw new ApiRequestError('Server returned an invalid response.', res.status); }
  if (!res.ok || !data.success) throw new ApiRequestError((data as ApiErrorBody).message || 'Could not read this link.', res.status);
  return data;
}

export interface DownloadResult { blob: Blob; filename: string }

export async function downloadMedia(url: string, quality: string, audio?: AudioFormat, onProgress?: (got: number, total: number) => void): Promise<DownloadResult> {
  const params = new URLSearchParams({ url, quality });
  if (audio) params.set('audio', audio);
  const res = await fetch(`${API_URL}/api/media/download?${params}`);
  if (!res.ok) {
    let message = 'Download failed. Please try again.';
    try { message = ((await res.json()) as ApiErrorBody).message || message; } catch { /* keep default */ }
    throw new ApiRequestError(message, res.status);
  }
  let blob: Blob;
  if (onProgress && res.body) {
    const total = Number(res.headers.get('Content-Length')) || 0;
    const reader = res.body.getReader();
    const parts: BlobPart[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length; onProgress(got, total);
    }
    blob = new Blob(parts, { type: res.headers.get('Content-Type') || undefined });
  } else blob = await res.blob();
  const match = /filename="?([^";]+)"?/i.exec(res.headers.get('Content-Disposition') || '');
  return { blob, filename: match?.[1] ?? (audio ? `audio.${audio}` : 'download.mp4') };
}

export function saveBlob({ blob, filename }: DownloadResult) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

// ---- Download with live progress: prepare (background job) -> poll progress -> native browser download ----
export type JobStatus = 'preparing' | 'downloading' | 'merging' | 'ready' | 'error';
export interface JobProgress { status: JobStatus; percent: number; message?: string }

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { signal, cache: 'no-store' });
  let data: (T & { success?: boolean; message?: string }) | undefined;
  try { data = await res.json(); } catch { throw new ApiRequestError('Server returned an invalid response.', res.status); }
  if (!res.ok || !data || data.success === false) throw new ApiRequestError(data?.message || 'Download failed. Please try again.', res.status);
  return data;
}

export async function prepareDownload(url: string, quality: string, audio?: AudioFormat, signal?: AbortSignal): Promise<string> {
  const params = new URLSearchParams({ url, quality });
  if (audio) params.set('audio', audio);
  return (await getJson<{ jobId: string }>(`/api/media/prepare?${params}`, signal)).jobId;
}

export const fetchProgress = (jobId: string, signal?: AbortSignal) =>
  getJson<JobProgress>(`/api/media/progress/${encodeURIComponent(jobId)}`, signal);

/** Hands the finished file to the browser's own download manager (progress bar, works for big files on phones). */
export function startFileDownload(jobId: string) {
  const a = document.createElement('a');
  a.href = `${API_URL}/api/media/file/${encodeURIComponent(jobId)}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
