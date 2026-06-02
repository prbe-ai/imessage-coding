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
import { reapStaleSessions } from './db/repo.ts';

const env = loadEnv();
const app = createApp();

// Warm the LISTEN/NOTIFY client at boot (best-effort; long-polls also reconnect).
ensureListener().catch((err) => {
  console.error('[boot] listener warm-up failed (will retry lazily)', err);
});

// Session liveness reaper. Devices heartbeat every 10s; the control plane is the
// source of truth for "live" because a client can't reliably announce its own
// death (SIGKILL / crash / sleep / lost network). Sweep stale sessions to
// `ended` so they drop out of the dashboard + orchestrator (both filter
// state <> 'ended'). Sweep cadence matches the heartbeat so detection latency
// stays tight. Idempotent, so running on every instance is fine; errors
// are logged, never thrown out of the timer.
const REAP_INTERVAL_MS = 10_000;
function sweepStaleSessions(): void {
  reapStaleSessions()
    .then((n) => {
      if (n > 0) console.log(`[reaper] ended ${n} stale session(s)`);
    })
    .catch((err) => console.error('[reaper] sweep failed (will retry)', err));
}
sweepStaleSessions(); // once at boot to clear anything stale from before restart
setInterval(sweepStaleSessions, REAP_INTERVAL_MS);

console.log(`[control-plane] listening on :${env.port}`);

export default {
  port: env.port,
  // Long-poll runs up to ~25s; keep sockets alive well beyond that.
  idleTimeout: 60,
  fetch: app.fetch,
};
