'use client';
import type { Downloader } from '@/hooks/useDownloader';
import { FB_RE, fixUrl, INSTA_RE, X_RE, YT_RE } from '@/lib/validation';
import type { AudioFormat, MediaFormat } from '@/types/api';
import { XIcon } from './PlatformIcons';

interface Props {
  d: Downloader;
  placeholder: string;
  label: string;
  example: string;
  red?: boolean;
  /** Shown as clickable "Ready" placeholders while the real qualities load. Never used as real options. */
  quickQualities?: string[];
  /** Render only the search bar, only the preview/format card, or both. */
  part?: 'bar' | 'card' | 'both';
}
const AUDIO: AudioFormat[] = ['mp3', 'm4a'];

/** Button text while a download is running: live percent + a thin progress bar. */
function Busy({ d }: { d: Downloader }) {
  return (
    <>
      <span>{d.progress || 'Preparing...'}</span>
      <i className="pbar" aria-hidden="true"><b style={{ width: `${d.percent || 0}%` }} /></i>
    </>
  );
}

export function DownloaderBox({ d, placeholder, label, example, red = false, quickQualities = [], part = 'both' }: Props) {
  const link = fixUrl(d.link);
  const yt = YT_RE.test(link);
  const ig = INSTA_RE.test(link);
  const fb = FB_RE.test(link);
  const xx = X_RE.test(link);
  const isRed = red || yt;
  const checking = d.loading && !d.info;
  const formats: MediaFormat[] = d.info
    ? d.info.formats
    : checking
      ? (yt ? quickQualities : []).map((q) => ({ quality: q, value: parseInt(q, 10), size: 0, locked: false }))
      : [];
  const hasHigh = formats.some((f) => f.value >= 1440);
  const showBox = !!d.info || checking;
  const pv = d.info ? { thumbnail: d.info.thumbnail ?? '', title: d.info.title, embedUrl: d.preview?.embedUrl ?? null } : d.preview;

  return (
    <>
      {part !== 'card' && <>
      <div className="plats" aria-hidden="true">
        <span className={ig ? 'on' : ''}>📷 Instagram</span>
        <span className={yt ? 'on red' : ''}>▶ YouTube</span>
        <span className={fb ? 'on fb' : ''}>📘 Facebook</span>
        <span className={xx ? 'on xx' : ''}><XIcon size={14} /> X</span>
      </div>
      <div className={`bar${isRed ? ' yt' : fb ? ' fb' : xx ? ' xx' : ''}`}>
        <label className="in" style={{ background: '#120d33' }}>
          🔗
          <input value={d.link} style={{ color: '#fff', WebkitTextFillColor: '#fff', caretColor: '#fff', background: 'transparent' }} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(e) => d.change(e.target.value)} onPaste={d.paste}
            onKeyDown={(e) => e.key === 'Enter' && d.analyze()} placeholder={placeholder} aria-label={label} />
          {d.link && <button type="button" className="x" onClick={d.clear} aria-label="Clear">✕</button>}
        </label>
        <button className={`btn${isRed ? ' red' : fb ? ' blue' : xx ? ' xx' : ''}`} onClick={d.analyze} disabled={d.loading}>
          {d.loading ? 'Checking...' : 'Get Link →'}
        </button>
      </div>
      <p className="msg" style={{ color: d.msg.ok ? '#0f9d74' : '#d6204f' }} role="status">{d.msg.text}</p>
      <p className="ex">{example}</p>
      </>}
      {part !== 'bar' && <>

      {pv && (
        <div className="pv">
          {pv.embedUrl ? (
            <iframe className={xx ? 'emb-x' : undefined} src={pv.embedUrl} title={pv.title || 'Post preview'} loading="eager"
              allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
          ) : (
            <>
              {pv.thumbnail && (
                // eslint-disable-next-line @next/next/no-img-element -- remote thumbnail from the platform CDN; no optimisation wanted
                <img src={pv.thumbnail} alt="Video thumbnail" referrerPolicy="no-referrer"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              )}
              <b>{pv.title || (d.loading ? 'Loading preview...' : '')}</b>
            </>
          )}
        </div>
      )}

      {!pv && checking && (
        <div className="pv pv-skel" aria-busy="true"><i aria-hidden="true" /><b>Loading preview...</b></div>
      )}

      {showBox && (
        <div className="qbox">
          <h4>🎬 Video (MP4)</h4>
          <div className="qgrid">
            {formats.length === 0 && (
              <button className="qbtn" disabled={!!d.busy} onClick={() => void d.download('best')}>
                {d.busy === 'best' ? <Busy d={d} /> : 'Download'}
                <small>{checking ? 'Best quality' : 'Original'}</small>
              </button>
            )}
            {formats.map((f) => (
              <button key={f.quality} className="qbtn" disabled={!!d.busy} onClick={() => void d.download(f.quality)}>
                {d.busy === f.quality ? <Busy d={d} /> : f.quality}
                <small>
                  {checking ? 'Ready' : [f.value >= 2160 ? '4K' : f.value >= 1440 ? '2K' : '', f.locked ? 'Premium' : ''].filter(Boolean).join(' · ') || 'Free'}
                </small>
              </button>
            ))}
          </div>
          {hasHigh && <p className="ex">1440p / 4K files may need VLC player on some devices.</p>}
          <h4 className="second">🎵 Audio only</h4>
          <div className="qgrid">
            {AUDIO.map((a) => {
              return (
                <button key={a} className="qbtn audio" disabled={!!d.busy} onClick={() => void d.download('best', a)}>
                  {d.busy === a ? <Busy d={d} /> : a.toUpperCase()}
                  <small>{a === 'mp3' ? 'Works everywhere' : 'Original quality'}</small>
                </button>
              );
            })}
          </div>
        </div>
      )}
      </>}
    </>
  );
}
