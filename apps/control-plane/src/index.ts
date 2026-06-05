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
import { claimDevicesToNotifyLost, reapStaleSessions } from './db/repo.ts';
import { notifyLostDevices } from './orchestrator/index.ts';
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
// `notify`: announce lost DEVICES to the phone (AFK-gated). OFF for the boot
// sweep — a deploy restart leaves healthy devices unable to heartbeat for the
// downtime window, so the first post-restart reap would false-positive on devices
// that reconnect seconds later. Boot stays cleanup-only; live detection (interval
// sweeps) is where a genuine drop gets surfaced.
//
// Cleanup and announcement are decoupled: reapStaleSessions just hides dead sessions
// from the dashboard/orchestrator; claimDevicesToNotifyLost is the DEVICE-keyed
// announcer. It texts at most once per offline episode and re-arms only when the user
// RE-ENGAGES (a new inbound message), so a laptop flapping all night — with no texting
// from the user — is announced exactly once regardless of flap cadence. The boot sweep
// stays notify=false so a deploy's own downtime window can't false-positive before
// devices have had a chance to re-beat.
// Delivery is best-effort-once: claimDevicesToNotifyLost locks the device (stamps
// lost_notified_at) as it claims, so if this instance dies between that commit and
// notifyLostDevices, that one notice is dropped (no other instance re-claims it).
// Acceptable — the bug we're fixing is OVER-notification; a delivery outbox is out of scope.
function sweepStaleSessions(notify: boolean): void {
  reapStaleSessions()
    .then(async (reaped) => {
      if (reaped.length > 0) console.log(`[reaper] ended ${reaped.length} stale session(s)`);
      if (!notify) return;
      const lost = await claimDevicesToNotifyLost();
      if (lost.length > 0) await notifyLostDevices(getTransport(), lost);
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
