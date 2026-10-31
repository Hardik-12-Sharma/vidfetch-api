// NEXT_PUBLIC_* must be referenced literally so Next can inline them at build time.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/+$/, '');
export const WEB3FORMS_KEY = process.env.NEXT_PUBLIC_WEB3FORMS_KEY || '';
export const ADSENSE_CLIENT = process.env.NEXT_PUBLIC_ADSENSE_CLIENT || '';
export const ADSENSE_SLOT = process.env.NEXT_PUBLIC_ADSENSE_SLOT || '';
export const IS_DEV = process.env.NODE_ENV !== 'production';
