/**
 * DASHBOARD API — the dashboard browser's interface to the control plane (the
 * single SSE hub + source of truth).
 *
 *   GET /api/dashboard/events?ticket=…  -> account-scoped SSE: `sessions`
 *
 * The dashboard opens ONE long-lived EventSource here and reacts to pushed
 * `sessions` events (the account's live sessions, incl. each session's
 * afk/state) — replacing the dashboard's old 5s poll. Driven by the same
 * LISTEN/NOTIFY bridge as the device stream: a `session_state` NOTIFY wakes the
 * account waiter, we re-query, and push.
 *
 * Auth = a short-TTL HMAC ticket (see ../auth/dashboard.ts). CORS is open
 * (`*`) — safe because the ticket, not a cookie, is the credential, the stream
 * is read-only, and it's account-scoped to the ticket's accountId.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { DashboardApiRoute, SseEvent } from '@imsg/shared';
import { listDevicesForAccount, listLiveSessionsForAccount } from '../db/repo.ts';
import { ensureListener, waitForAccountEvent } from '../db/listener.ts';
import { verifySseTicket } from '../auth/dashboard.ts';

/** SSE keepalive cadence (ms) — ping under proxy idle timeouts (matches device). */
const SSE_HEARTBEAT_MS = 25_000;

export const dashboardRoutes = new Hono();

dashboardRoutes.get(DashboardApiRoute.EVENTS, async (c) => {
  // CORS: ticket-authed + credential-less + read-only → `*` is safe. Set before
  // any early return so the browser can read a 401 body too.
  c.header('Access-Control-Allow-Origin', '*');

  const ticket = c.req.query('ticket') ?? '';
  const auth = ticket ? verifySseTicket(ticket) : null;
  if (!auth) {
    return c.json({ error: 'invalid_ticket' }, 401);
  }
  const { accountId } = auth;
  await ensureListener();

  return streamSSE(c, async (stream) => {
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });

    // Emit the account's current live sessions + paired devices (machine-wide
    // afk lives on the device). The browser replaces each list wholesale
    // on its event (idempotent); low volume, so always send both. A device toggle
    // fires `device_state`, which wakes this account waiter too (see listener).
    const flush = async (): Promise<void> => {
      const [sessions, devices] = await Promise.all([
        listLiveSessionsForAccount(accountId),
        listDevicesForAccount(accountId),
      ]);
      await stream.writeSSE({ event: SseEvent.SESSIONS, data: JSON.stringify({ sessions }) });
      await stream.writeSSE({ event: SseEvent.DEVICES, data: JSON.stringify({ devices }) });
    };

    // Catch-up on connect, then stream live. Re-query EVERY iteration (not only
    // on wake) so a NOTIFY firing in the window between flush() returning and the
    // next waiter registering is not stranded — same guard the device stream
    // uses; the timeout bounds worst-case staleness to one heartbeat.
    await flush();
    while (!aborted && !c.req.raw.signal.aborted) {
      const woken = await waitForAccountEvent(accountId, SSE_HEARTBEAT_MS, c.req.raw.signal);
      if (aborted || c.req.raw.signal.aborted) break;
      await flush();
      if (!woken) await stream.writeSSE({ event: SseEvent.PING, data: '{}' });
    }
  });
});
