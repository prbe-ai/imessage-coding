/**
 * Control plane entrypoint (Bun).
 *
 * Bun serves a module's default export `{ port, fetch }`. We build the Hono app,
 * eagerly validate env (fail loud at boot), warm the LISTEN/NOTIFY listener so
 * the first SSE stream wakes correctly, and export the fetch handler.
 *
 * `idleTimeout` is raised above the SSE keepalive cadence (15s heartbeat) so a
 * long-lived GET /api/device/events stream isn't killed by Bun's default 10s idle.
 */
import { createApp } from './app.ts';
import { loadEnv } from './env.ts';
import { ensureListener } from './db/listener.ts';
import { reapStaleSessions } from './db/repo.ts';
import { notifyEndedSessions } from './orchestrator/index.ts';
import { getTransport } from './transport.ts';

const env = loadEnv();
const app = createApp();

// Warm the LISTEN/NOTIFY client at boot (best-effort; SSE streams also reconnect).
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
// `notify`: text the user (AFK-gated) that their session stopped. OFF for the
// boot sweep — a deploy restart leaves healthy devices unable to heartbeat for
// the downtime window, so the first post-restart reap would false-positive on
// sessions that reconnect seconds later. Boot stays cleanup-only; live detection
// (interval sweeps) is where a genuine stop gets surfaced.
function sweepStaleSessions(notify: boolean): void {
  reapStaleSessions()
    .then(async (reaped) => {
      if (reaped.length > 0) console.log(`[reaper] ended ${reaped.length} stale session(s)`);
      if (notify && reaped.length > 0) await notifyEndedSessions(getTransport(), reaped);
    })
    .catch((err) => console.error('[reaper] sweep failed (will retry)', err));
}
sweepStaleSessions(false); // once at boot to clear anything stale from before restart
setInterval(() => sweepStaleSessions(true), REAP_INTERVAL_MS);

console.log(`[control-plane] listening on :${env.port}`);

export default {
  port: env.port,
  // SSE streams ping every 15s; keep sockets alive well beyond that.
  idleTimeout: 60,
  fetch: app.fetch,
};
