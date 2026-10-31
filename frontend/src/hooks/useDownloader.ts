'use client';
import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { errorMessage, fetchMediaInfo, fetchProgress, prepareDownload, startFileDownload, ApiRequestError } from '@/lib/api';
import { fixUrl, instaPreviewUrl, X_RE, xPreviewUrl, ytId } from '@/lib/validation';
import type { AudioFormat, MediaInfo } from '@/types/api';

export interface Preview { thumbnail: string; title: string; embedUrl: string | null }
export interface Message { text: string; ok: boolean }
interface Options { validate: (url: string) => boolean; invalidText: string; auto?: boolean }

export function useDownloader({ validate, invalidText, auto = true }: Options) {
  const [link, setLink] = useState('');
  const [msg, setMsg] = useState<Message>({ text: '', ok: true });
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState('');
  const [percent, setPercent] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const lastUrl = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    lastUrl.current = '';
    setInfo(null);
    setPreview(null);
    setLoading(false);
  }, []);

  const analyzeUrl = useCallback(async (url: string) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    lastUrl.current = url;
    setLoading(true);
    setInfo(null);
    setMsg({ text: 'Checking link and loading preview...', ok: true });

    // Preview starts immediately, in parallel with the backend analysis.
    // Instagram / X: the platform's own embed shows the real post right away. Never treat those links as YouTube.
    const embedUrl = instaPreviewUrl(url) ?? xPreviewUrl(url);
    const id = embedUrl ? null : ytId(url);
    if (id) {
      setPreview({ thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, title: '', embedUrl: null });
      fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { signal: ac.signal })
        .then((r) => r.json())
        .then((o: { title?: string }) => { if (!ac.signal.aborted && o.title) setPreview((p) => (p ? { ...p, title: o.title! } : p)); })
        .catch(() => undefined);
    } else if (embedUrl) {
      setPreview({ thumbnail: '', title: X_RE.test(url) ? 'X post preview' : 'Instagram video preview', embedUrl });
    } else {
      setPreview(null);
    }

    try {
      const data = await fetchMediaInfo(url, ac.signal);
      if (ac.signal.aborted) return;
      setInfo(data);
      setMsg({ text: 'Link looks good. Choose a format below.', ok: true });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      lastUrl.current = '';
      setMsg({ text: errorMessage(e), ok: false });
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  const change = useCallback((v: string) => {
    setLink(v);
    reset();
    setMsg({ text: '', ok: true });
    if (timerRef.current) clearTimeout(timerRef.current);
    const url = fixUrl(v);
    if (auto && validate(url)) timerRef.current = setTimeout(() => void analyzeUrl(url), 60);
  }, [auto, validate, reset, analyzeUrl]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const analyze = () => {
    const url = fixUrl(link);
    if (!validate(url)) { reset(); setMsg({ text: invalidText, ok: false }); return; }
    if (url === lastUrl.current && (loading || info)) return;
    void analyzeUrl(url);
  };

  const paste = (e: ClipboardEvent<HTMLInputElement>) => {
    const t = fixUrl(e.clipboardData?.getData('text') || '');
    if (validate(t)) { e.preventDefault(); change(t); }
  };

  const clear = () => change('');

  const download = async (quality: string, audio?: AudioFormat) => {
    const key = audio || quality;
    const label = audio ? audio.toUpperCase() : quality;
    setBusy(key); setProgress(''); setPercent(0);
    setMsg({ text: `Preparing ${label}...`, ok: true });
    const started = Date.now();
    try {
      const jobId = await prepareDownload(fixUrl(link), quality, audio);
      let failures = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, 250));
        if (Date.now() - started > 6 * 60_000) throw new ApiRequestError('This is taking too long. Please try again.');
        let p;
        try { p = await fetchProgress(jobId); failures = 0; }
        catch (e) { if (e instanceof ApiRequestError || ++failures > 5) throw e; continue; }   // brief network hiccup: keep polling
        if (p.status === 'error') throw new ApiRequestError(p.message || 'Download failed. Please try again.');
        if (p.status === 'ready') break;
        setPercent(p.percent);
        if (p.status === 'merging') { setProgress('Finishing...'); setMsg({ text: `Finishing ${label}...`, ok: true }); }
        else if (p.percent > 0) { setProgress(`${p.percent}%`); setMsg({ text: `Downloading ${label}... ${p.percent}%`, ok: true }); }
      }
      setPercent(100); setProgress('Saving...');
      startFileDownload(jobId);
      setMsg({ text: 'Done! Your download has started.', ok: true });
    } catch (e) {
      setMsg({ text: errorMessage(e), ok: false });
    } finally {
      setTimeout(() => { setBusy(''); setProgress(''); setPercent(0); }, 800);
    }
  };

  return { link, msg, info, preview, loading, busy, progress, percent, change, paste, clear, analyze, download };
}
export type Downloader = ReturnType<typeof useDownloader>;
