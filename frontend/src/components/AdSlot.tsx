'use client';
import { useEffect } from 'react';
import { ADSENSE_CLIENT, ADSENSE_SLOT, IS_DEV } from '@/lib/env';

declare global { interface Window { adsbygoogle?: unknown[] } }

export function AdSlot() {
  useEffect(() => {
    if (!ADSENSE_CLIENT) return;
    if (!document.querySelector('script[data-adsense]')) {
      const s = document.createElement('script');
      s.async = true;
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;
      s.crossOrigin = 'anonymous';
      s.setAttribute('data-adsense', '1');
      document.head.appendChild(s);
    }
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* ad blocked */ }
  }, []);

  if (!ADSENSE_CLIENT) return IS_DEV ? <div className="adph">Ad space (set NEXT_PUBLIC_ADSENSE_CLIENT)</div> : null;
  return (
    <div className="adwrap">
      <small>Advertisement</small>
      <ins className="adsbygoogle" style={{ display: 'block' }} data-ad-client={ADSENSE_CLIENT} data-ad-slot={ADSENSE_SLOT}
        data-ad-format="auto" data-full-width-responsive="true" />
    </div>
  );
}
