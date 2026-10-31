import { spawn, type ChildProcess } from 'node:child_process';

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; spawnFailed: boolean }
export interface RunOptions {
  timeoutMs: number; signal?: AbortSignal; maxStdout?: number; maxStderr?: number;
  /** Called for every complete output line (stdout and stderr), e.g. to read yt-dlp progress. */
  onLine?: (line: string) => void;
}

/** Splits a text stream into lines (handles both \n and \r, which progress bars use). */
function lineSplitter(cb: (line: string) => void) {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) cb(line);
    }
    if (buf.length > 4096) buf = buf.slice(-4096);
  };
}

const SECRET_ENV = /^(RAZORPAY_|PREMIUM_)/;
/** Child processes never see payment/premium secrets. */
export function childEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(src).filter(([k]) => !SECRET_ENV.test(k)));
}

function killTree(p: ChildProcess) {
  if (!p.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-p.pid, 'SIGKILL'); // own process group (detached) => kills yt-dlp's ffmpeg children too
  } catch { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
}

/**
 * Spawns a process WITHOUT a shell (args are an array, never interpolated), enforces a timeout,
 * supports AbortSignal cancellation, and tracks live children so shutdown can kill them.
 */
export class ProcessRunner {
  private live = new Set<ChildProcess>();

  run(cmd: string, args: string[], o: RunOptions): Promise<RunResult> {
    return new Promise((resolve) => {
      const res: RunResult = { code: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnFailed: false };
      if (o.signal?.aborted) return resolve({ ...res, aborted: true });
      const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, env: childEnv() });
      this.live.add(p);
      const maxOut = o.maxStdout ?? 20 * 1024 * 1024, maxErr = o.maxStderr ?? 64 * 1024;
      const outLines = o.onLine ? lineSplitter(o.onLine) : undefined;
      const errLines = o.onLine ? lineSplitter(o.onLine) : undefined;
      p.stdout!.setEncoding('utf8').on('data', (d: string) => { if (res.stdout.length < maxOut) res.stdout += d; outLines?.(d); });
      p.stderr!.setEncoding('utf8').on('data', (d: string) => { res.stderr = (res.stderr + d).slice(-maxErr); errLines?.(d); });
      const timer = setTimeout(() => { res.timedOut = true; killTree(p); }, o.timeoutMs);
      const onAbort = () => { res.aborted = true; killTree(p); };
      o.signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => { clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); this.live.delete(p); resolve(res); };
      p.once('error', () => { res.spawnFailed = true; done(); });
      p.once('close', (code) => { res.code = code; done(); });
    });
  }

  killAll() { for (const p of this.live) killTree(p); }
  get activeCount() { return this.live.size; }
}
