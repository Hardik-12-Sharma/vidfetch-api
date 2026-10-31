import fs from 'node:fs/promises';
import path from 'node:path';

export const removeDir = (dir: string | null | undefined) => (dir ? fs.rm(dir, { recursive: true, force: true }).catch(() => undefined) : Promise.resolve());

/** Deletes leftover `dl-*` work dirs older than maxAgeMs (crash recovery). Never touches anything else. */
export async function sweepStale(tmpDir: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let n = 0;
  for (const e of await fs.readdir(tmpDir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !/^dl-/.test(e.name)) continue;
    const full = path.join(tmpDir, e.name);
    const st = await fs.stat(full).catch(() => null);
    if (st && now - st.mtimeMs > maxAgeMs) { await removeDir(full); n++; }
  }
  return n;
}
