/**
 * Control plane entrypoint (Bun).
 *
 * Bun serves a module's default export `{ port, fetch }`. We build the Hono app,
 * eagerly validate env (fail loud at boot), warm the LISTEN/NOTIFY listener so
 * the first long-poll wakes correctly, and export the fetch handler.
 *
 * `idleTimeout` is raised above the long-poll ceiling so parked
 * GET /api/device/decisions requests are not killed by Bun's default 10s idle.
 */
import { createApp } from './app.ts';
import { loadEnv } from './env.ts';
import { ensureListener } from './db/listener.ts';

const env = loadEnv();
const app = createApp();

// Warm the LISTEN/NOTIFY client at boot (best-effort; long-polls also reconnect).
ensureListener().catch((err) => {
  console.error('[boot] listener warm-up failed (will retry lazily)', err);
});

console.log(`[control-plane] listening on :${env.port}`);

export default {
  port: env.port,
  // Long-poll runs up to ~25s; keep sockets alive well beyond that.
  idleTimeout: 60,
  fetch: app.fetch,
};
