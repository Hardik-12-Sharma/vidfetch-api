'use client';
import { useCallback } from 'react';
import { useDownloader } from '@/hooks/useDownloader';
import { isSupportedLink } from '@/lib/validation';
import { AdSlot } from './AdSlot';
import { DownloaderBox } from './DownloaderBox';
import { XIcon } from './PlatformIcons';
import { Reviews } from './Reviews';
import { SiteNav } from './SiteNav';

const feats: Array<[string, string, string]> = [
  ['⚡', 'Lightning Fast', 'Get your files in seconds.'],
  ['🛡️', 'High Quality', 'HD, 4K and more.'],
  ['🖥️', 'All Devices', 'Mobile, tablet, desktop.'],
  ['🔓', 'No Login', 'Completely free to use.'],
  ['∞', 'Multiple Formats', 'MP4, MP3 and M4A.'],
];
const steps: Array<[string, string, string]> = [
  ['🔗', 'Paste Link', 'Copy and paste your YouTube, Instagram, Facebook or X URL.'],
  ['⚙️', 'Choose Format', 'Pick video or audio and the quality you want.'],
  ['⬇️', 'Download', 'Tap once and the file is saved on your device.'],
];

export function InstaLanding() {
  const validate = useCallback((v: string) => isSupportedLink(v), []);
  const d = useDownloader({ validate, invalidText: 'Paste a valid YouTube, Instagram, Facebook or X video link.' });
  const props = { d, placeholder: 'Paste your video link here...', label: 'YouTube, Instagram, Facebook or X link', example: 'Works with public videos, Reels, Shorts and X posts.', quickQualities: ['144p', '360p', '720p', '1080p'] };
  return (
    <div className="fi">
      <div className="wrap">
        <SiteNav />
        <section className="hero" id="home">
          <div>
            <span className="badge">⚡ Fast · Free · No Login Required</span>
            <h1>Download <span className="g1">Videos</span> &amp; <span className="g2">Audio</span><br />from <span className="yt">YouTube,</span> <span className="pink">Instagram,</span> <span className="fbc">Facebook</span> &amp; <span className="xt">X</span></h1>
            <p className="sub">Paste the video link, choose your format and quality, and download in seconds. Simple. Fast. Free.</p>
            <DownloaderBox {...props} part="bar" />
          </div>
          <div className="phoneart" aria-hidden="true">
            <i className="ic ytc">▶</i><i className="ic igc">📷</i><i className="ic fbi">f</i>
            <i className="ic xi"><XIcon size={28} /></i>
            <div className="phone"><div className="screen"><span>▶</span></div><b>Video (MP4)</b><b>Audio (MP3)</b></div>
          </div>
        </section>
        <section className="strip" id="features">
          {feats.map(([i, t, s]) => (<div key={t}><span className="ico">{i}</span><p><b>{t}</b><span>{s}</span></p></div>))}
        </section>
        <section className="grid2">
          <div className="card dl"><h3>Download Preview</h3><DownloaderBox {...props} part="card" /><p className="ex">Paste a link above and the title, size and qualities appear here.</p></div>
          <div className="card works"><h3>Works with 4 Major Platforms</h3>
            <div className="ptiles">
              <div className="ptile"><i className="ic ytc">▶</i><span>YouTube</span></div>
              <div className="ptile"><i className="ic igc">📷</i><span>Instagram</span></div>
              <div className="ptile"><i className="ic fbi">f</i><span>Facebook</span></div>
              <div className="ptile"><i className="ic xi"><XIcon size={26} /></i><span>X</span></div>
            </div>
            <ul><li>Paste Link</li><li>Choose Format &amp; Quality</li><li>Download Instantly</li></ul>
          </div>
        </section>
        <section className="how" id="how">
          <h2>How It Works</h2>
          <div className="steps">{steps.map(([i, t, s], n) => (<div className="card" key={t}><span className="ico">{i}</span><p><b>{n + 1}. {t}</b><span>{s}</span></p></div>))}</div>
        </section>
        <AdSlot />
        <Reviews />
      </div>
    </div>
  );
}
