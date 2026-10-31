import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  // Preflight is OFF on purpose: the original design is hand-written CSS (see globals.css) that relies on
  // browser-default margins/typography in places. Enabling the reset would change the look.
  corePlugins: { preflight: false },
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
