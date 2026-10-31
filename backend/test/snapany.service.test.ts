import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnapAnyService } from '../src/services/snapany.service.js';
import { ProcessRunner, type RunOptions, type RunResult } from '../src/utils/exec.js';

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const POST = {
  site: 'youtube',
  title: 'SnapAny Test Clip',
  medias: [
    {
      media_type: 'video',
      preview_url: 'https://i.ytimg.com/vi/test/maxresdefault.jpg',
      duration: 125,
      variants: [
        { quality: 360, video_proxy_url: 'https://proxy.snapany.test/360-video', video_ext: 'mp4', video_filesize: 1000 },
        { quality: 720, video_proxy_url: 'https://proxy.snapany.test/720-video', video_ext: 'mp4', video_filesize: 2000, audio_proxy_url: 'https://proxy.snapany.test/720-audio', audio_ext: 'm4a', audio_filesize: 500 },
        { quality: 1080, video_proxy_url: 'https://proxy.snapany.test/1080-video', video_ext: 'mp4', video_filesize: 3000, audio_proxy_url: 'https://proxy.snapany.test/1080-audio', audio_ext: 'm4a', audio_filesize: 700 },
      ],
    },
    {
      media_type: 'audio',
      resource_proxy_url: 'https://proxy.snapany.test/audio-resource',
      duration: 125,
      variants: [{ audio_proxy_url: 'https://proxy.snapany.test/audio-track', audio_ext: 'm4a', audio_filesize: 500 }],
    },
  ],
};

const INFO_POST = {
  ...POST,
  medias: POST.medias?.map((media) => ({
    ...media,
    resource_proxy_url: undefined,
    resource_url: media.media_type === 'video' ? 'https://rr1.googlevideo.test/video' : 'https://rr1.googlevideo.test/audio',
    variants: [
      ...(media.variants?.map((variant) => ({
        ...variant,
        video_proxy_url: undefined,
        audio_proxy_url: undefined,
        video_url: (variant as { video_ext?: string }).video_ext ? 'https://rr1.googlevideo.test/video-variant' : undefined,
        audio_url: (variant as { audio_ext?: string }).audio_ext ? 'https://rr1.googlevideo.test/audio-variant' : undefined,
      })) ?? []),
      ...(media.media_type === 'video' ? [{ quality: 1440, video_url: 'https://rr1.googlevideo.test/video-1440', video_ext: 'mp4', video_filesize: 3_000 }] : []),
    ],
  })),
};

class FakeRunner extends ProcessRunner {
  calls: Array<{ cmd: string; args: string[] }> = [];
  override async run(cmd: string, args: string[], _options: RunOptions): Promise<RunResult> {
    this.calls.push({ cmd, args });
    const output = args[args.length - 1];
    await fs.writeFile(output, 'MERGED_MEDIA');
    return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, spawnFailed: false };
  }
}

let tmpDir = '';
async function createService() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapany-test-'));
  const runner = new FakeRunner();
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/youtube/proxy-download')) {
      return new Response(JSON.stringify(POST), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/extract/post')) {
      return new Response(JSON.stringify(INFO_POST), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('proxy.snapany.test')) {
      return new Response(Buffer.from(`MEDIA:${url}`), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(Buffer.byteLength(`MEDIA:${url}`)) } });
    }
    return new Response('not found', { status: 404 });
  };
  const service = new SnapAnyService({ apiKey: 'test-snapany-key', tmpDir, maxFilesize: '20M', fetchImpl }, runner);
  await service.init();
  return { service, runner, requests };
}
afterEach(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }); });

describe('SnapAnyService', () => {
  it('maps the provider response to the existing MediaInfo contract and caches extraction', async () => {
    const { service, requests } = await createService();
    const first = await service.fetchInfo(YT);
    const second = await service.fetchInfo(YT);
    expect(first).toEqual({
      platform: 'youtube', title: 'SnapAny Test Clip', thumbnail: 'https://i.ytimg.com/vi/test/maxresdefault.jpg',
      duration: 125, audioSize: 500,
      qualities: [{ quality: 360, size: 1000 }, { quality: 720, size: 2500 }, { quality: 1080, size: 3700 }], // 1440p hidden because proxy downloads are capped at 1080p
    });
    expect(second).toEqual(first);
    expect(requests.filter((url) => url.includes('/extract/post'))).toHaveLength(1);
    expect(requests.filter((url) => url.includes('/youtube/proxy-download'))).toHaveLength(0);
    await service.close();
  });

  it('downloads the closest available quality at or below the request, merges streams and reuses the extraction', async () => {
    const { service, runner, requests } = await createService();
    await service.fetchInfo(YT);
    const file = await service.download(YT, 720);
    expect(file.ext).toBe('mp4');
    expect(await fs.readFile(file.path, 'utf8')).toBe('MERGED_MEDIA');
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.cmd).toBe('ffmpeg');
    expect(requests).toContain('https://proxy.snapany.test/720-video');
    expect(requests).toContain('https://proxy.snapany.test/720-audio');
    // Proxy streams are first downloaded to local files; FFmpeg merges those local files.
    expect(runner.calls[0]!.args.some((arg) => arg.endsWith('video.mp4'))).toBe(true);
    expect(runner.calls[0]!.args.some((arg) => arg.endsWith('audio.m4a'))).toBe(true);
    expect(requests.some((url) => url.includes('1080-video'))).toBe(false);
    expect(requests.filter((url) => url.includes('/extract/post'))).toHaveLength(1);
    expect(requests.filter((url) => url.includes('/youtube/proxy-download'))).toHaveLength(1);
    await service.cleanup(file);
    expect(await fs.stat(file.dir).catch(() => null)).toBeNull();
    await service.close();
  });

  it('downloads audio from the audio resource proxy and converts MP3 with ffmpeg', async () => {
    const { service, runner, requests } = await createService();
    const file = await service.downloadAudio(YT, 'mp3');
    expect(file.ext).toBe('mp3');
    expect(runner.calls[0]!.args).toContain('libmp3lame');
    expect(requests).toContain('https://proxy.snapany.test/audio-resource');
    await service.cleanup(file);
    await service.close();
  });

  it('rejects non-HTTPS or local proxy URLs before fetching them', async () => {
    const { service, requests } = await createService();
    const bad = { ...POST, medias: [{ media_type: 'video', duration: 10, variants: [{ quality: 360, video_proxy_url: 'http://127.0.0.1/private', video_ext: 'mp4' }] }] };
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes('/youtube/proxy-download')) return new Response(JSON.stringify(bad), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('Should not request unsafe URL');
    };
    // A separate service with the malicious provider response proves the proxy URL is validated.
    const unsafe = new SnapAnyService({ apiKey: 'test', tmpDir, maxFilesize: '20M', fetchImpl });
    await unsafe.init();
    await expect(unsafe.download(YT, 360)).rejects.toThrow('unsafe download link');
    expect(requests.some((url) => url.includes('127.0.0.1'))).toBe(false);
    await unsafe.close();
    await service.close();
  });
});
