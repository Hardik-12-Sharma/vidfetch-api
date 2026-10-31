'use client';
import { useAdblock } from '@/hooks/useAdblock';

/** Full-screen notice shown only when ads are configured AND an ad blocker is detected (same rules as before). */
export function AdblockGate() {
  if (!useAdblock()) return null;
  return (
    <div className="fi">
      <div className="fixed inset-0 z-[100] grid place-items-center bg-[#140a28e0] p-4">
        <div className="card" style={{ padding: 28, maxWidth: 440, textAlign: 'center' }}>
          <div style={{ fontSize: 44 }}>🚫</div>
          <h2>Please turn off your ad blocker</h2>
          <p>This site is free to use and ads help keep it running. Please disable your ad blocker for this site and refresh.</p>
          <button className="btn" style={{ borderRadius: 14, padding: 14, marginTop: 16 }} onClick={() => window.location.reload()}>
            I have disabled it — Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
