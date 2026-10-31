import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AdblockGate } from '@/components/AdblockGate';
import { API_URL } from '@/lib/env';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fastest Insta Video Downloader',
  description: 'Download Instagram, YouTube, Facebook and X videos and audio. Paste a link, preview it, and pick a quality.',
  icons: { icon: '/favicon.svg' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href={API_URL} crossOrigin="anonymous" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" />
      </head>
      <body>
        {/* #root keeps the original Vite layout rules (centred 1126px column) intact. */}
        <div id="root">
          <AdblockGate />
          {children}
        </div>
      </body>
    </html>
  );
}
