import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';

// Load backend/.env if present (real environment variables still win). Needs Node >= 20.12.
try { process.loadEnvFile('.env'); } catch { /* no .env file or older Node: use real env vars / defaults */ }

const config = loadConfig();
const app = await buildApp(config);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try { await app.close(); process.exit(0); } catch { process.exit(1); }
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
