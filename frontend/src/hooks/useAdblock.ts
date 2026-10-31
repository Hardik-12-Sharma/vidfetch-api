'use client';
import { useCallback, useEffect, useState } from 'react';
import { ADSENSE_CLIENT, IS_DEV } from '@/lib/env';

/** True only when AdSense is configured, we are in production, and an ad blocker is detected. */
export function useAdblock(): boolean {
  const [blocked, setBlocked] = useState(false);
  const check = useCallback(async () => {
    let found = false;
    const bait = document.createElement('div');
    bait.className = 'adsbox ad-banner ad-placement adsbygoogle pub_300x250 text-ad';
    bait.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:10px;height:10px;';
    bait.innerHTML = '&nbsp;';
    document.body.appendChild(bait);
    await new Promise((r) => setTimeout(r, 150));
    const cs = window.getComputedStyle(bait);
    if (bait.offsetHeight === 0 || cs.display === 'none' || cs.visibility === 'hidden') found = true;
    bait.remove();
    if (!found) {
      try {
        await fetch('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
      } catch { found = true; }
    }
    setBlocked(found);
  }, []);
  useEffect(() => {
    if (IS_DEV || !ADSENSE_CLIENT) return; // no ads configured => nothing to detect
    void check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [check]);
  return !IS_DEV && !!ADSENSE_CLIENT && blocked;
}
