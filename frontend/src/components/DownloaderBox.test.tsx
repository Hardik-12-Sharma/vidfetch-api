import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Downloader } from '@/hooks/useDownloader';
import type { MediaInfo } from '@/types/api';
import { DownloaderBox } from './DownloaderBox';

afterEach(cleanup);

const info: MediaInfo = {
  success: true, platform: 'youtube', title: 'Clip', thumbnail: 'https://i.ytimg.com/x.jpg', freeMaxQuality: 4320, audioSize: 1_600_000, mp3Size: 3_000_000,
  formats: [{ quality: '360p', value: 360, locked: false, size: 10_000_000 }, { quality: '2160p', value: 2160, locked: false, size: 0 }],
};
function fake(over: Partial<Downloader> = {}): Downloader & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    link: '', msg: { text: '', ok: true }, info: null, preview: null, loading: false, busy: '', progress: '', percent: 0,
    change: () => undefined, paste: () => undefined, clear: () => undefined, analyze: () => { calls.push(['analyze']); },
    download: async (...a: unknown[]) => { calls.push(['download', ...a]); }, calls, ...over,
  } as Downloader & { calls: unknown[][] };
}
const props = { placeholder: 'Paste here', label: 'Link', example: 'Example' };

describe('DownloaderBox', () => {
  it('empty state: only the input and the Download button, no format box', () => {
    render(<DownloaderBox d={fake()} {...props} />);
    expect(screen.getByLabelText('Link')).toBeTruthy();
    expect(screen.queryByText('Video (MP4)', { exact: false })).toBeNull();
  });
  it('loading state: button says Checking... and is disabled', () => {
    render(<DownloaderBox d={fake({ loading: true })} {...props} />);
    const b = screen.getByText('Checking...') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
  });
  it('error state: shows the message', () => {
    render(<DownloaderBox d={fake({ msg: { text: 'This content is private.', ok: false } })} {...props} />);
    expect(screen.getByRole('status').textContent).toBe('This content is private.');
  });
  it('ready state: lists formats (no file sizes), and clicking calls download with the right args', () => {
    const d = fake({ info });
    render(<DownloaderBox d={d} {...props} />);
    expect(screen.queryByText('~9.5 MB')).toBeNull();        // sizes are intentionally not shown
    expect(screen.getByText('4K')).toBeTruthy();
    fireEvent.click(screen.getByText('360p'));
    fireEvent.click(screen.getByText('MP3'));
    fireEvent.click(screen.getByText('M4A'));
    expect(d.calls).toEqual([['download', '360p'], ['download', 'best', 'mp3'], ['download', 'best', 'm4a']]);
  });
  it('busy state disables every format button', () => {
    render(<DownloaderBox d={fake({ info, busy: '360p' })} {...props} />);
    expect((screen.getByText('Preparing...').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('MP3') as HTMLButtonElement).disabled).toBe(true);
  });
  it('busy state shows the live percentage inside the button', () => {
    render(<DownloaderBox d={fake({ info, busy: '360p', progress: '45%', percent: 45 })} {...props} />);
    expect(screen.getByText('45%')).toBeTruthy();
  });
  it('an X link lights up the X platform pill (and nothing else)', () => {
    const pills = (c: HTMLElement) => Array.from(c.querySelectorAll('.plats span')).map((el) => el.className);   // Instagram, YouTube, Facebook, X
    const { container } = render(<DownloaderBox d={fake({ link: 'https://x.com/someuser/status/123456789?s=20' })} {...props} />);
    expect(pills(container)).toEqual(['', '', '', 'on xx']);
  });
  it('an X link gives the Get Link button its own colour class', () => {
    render(<DownloaderBox d={fake({ link: 'https://twitter.com/someuser/status/123456789' })} {...props} />);
    expect(screen.getByText('Get Link →').className).toContain('xx');
  });
  it('a link with no instant embed (Facebook) shows a loading placeholder instead of nothing', () => {
    render(<DownloaderBox d={fake({ loading: true, link: 'https://www.facebook.com/reel/123456' })} {...props} />);
    expect(screen.getByText('Loading preview...')).toBeTruthy();
  });
  it('an X post shows its embed straight away (no placeholder) with the X embed class', () => {
    const preview = { thumbnail: '', title: 'X post preview', embedUrl: 'https://platform.twitter.com/embed/Tweet.html?id=123456789' };
    const { container } = render(<DownloaderBox d={fake({ loading: true, link: 'https://x.com/someuser/status/123456789', preview })} {...props} />);
    expect(container.querySelector('iframe.emb-x')).toBeTruthy();
    expect(screen.queryByText('Loading preview...')).toBeNull();
  });
  it('Enter in the input triggers analyze', () => {
    const d = fake(); render(<DownloaderBox d={d} {...props} />);
    fireEvent.keyDown(screen.getByLabelText('Link'), { key: 'Enter' });
    expect(d.calls).toEqual([['analyze']]);
  });
});
