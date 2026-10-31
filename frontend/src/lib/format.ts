/** Human-readable size used on the format buttons. Empty string when the size is unknown. */
export function fmtSize(bytes: number | undefined | null): string {
  if (!bytes || bytes <= 0) return '';
  const MB = 1024 * 1024, GB = MB * 1024;
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < GB) { const mb = bytes / MB; return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`; }
  return `${(bytes / GB).toFixed(2)} GB`;
}

export function formatBytes(bytes: number | undefined | null, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  // Convert string to number if needed
  const bytesNum = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;

  const i = Math.floor(Math.log(bytesNum) / Math.log(k));
  return parseFloat((bytesNum / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
