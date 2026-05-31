/**
 * DEVICE API — the plugin's interface to the control plane.
 *
 * All routes except PAIR require a Bearer device_token (requireDevice) and are
 * scoped to the authenticated device + account. PAIR exchanges a single-use
 * pairing token for a device_token (returned exactly once).
 *
 *   POST /api/device/pair       {pairingToken, os?, hostname?} -> {deviceToken}
 *   POST /api/device/attention  AttentionEvent[]               -> {accepted}
 *   GET  /api/device/decisions  ?sessionId&since               -> LONG-POLL
 *   POST /api/device/heartbeat  {sessionId, cwd?}              -> {ok}
 *   POST /api/device/state      {sessionId?, afk?, grant?}     -> SessionInfo(s)
 *   GET  /api/device/state                                     -> {enabled, afk, grant}
 *
 * POST /state with NO sessionId is the CLI's device-wide toggle (`imsg
 * afk/grant`): afk/grant apply to ALL the device's live sessions. GET /state is
 * the remote killswitch probe: enabled = (revoked_at IS NULL AND disabled_at IS
 * NULL) for the authenticated device.
 *
 * The decisions long-poll waits on LISTEN/NOTIFY 'decision_ready' (or ~25s) and
 * returns resolved Decisions for the device's session. FAIL-CLOSED: a timeout
 * returns an empty list, never a default allow.
 */
import { Hono, type Context } from 'hono';
import {
  AfkState,
  AttentionKind,
  DeviceApiRoute,
  SessionState,
  isAfkState,
  isAttentionEvent,
  isGrantLevel,
  type AttentionEvent,
} from '@imsg/shared';
import {
  DEVICE_CTX_KEY,
  generateDeviceToken,
  hashToken,
  requireDevice,
  type DeviceAuth,
  type DeviceHonoEnv,
} from '../auth/device.ts';
import {
  consumePairingTokenAndCreateDevice,
  getDeviceState,
  getSessionForDevice,
  insertAttentionEvent,
  listDecisionsForSession,
  listUndeliveredSessionMessages,
  markSessionMessagesDelivered,
  touchSession,
  updateSessionState,
  updateSessionStateForDevice,
  upsertSession,
} from '../db/repo.ts';
import { ensureListener, waitForDecision, waitForSessionEvent } from '../db/listener.ts';
import { streamSSE } from 'hono/streaming';
import { getTransport } from '../transport.ts';
import { runAgentEventTurn } from '../orchestrator/index.ts';

/** Long-poll ceiling (ms). Below typical 30s proxy/client timeouts. */
const LONG_POLL_MS = 25_000;

/** SSE keepalive cadence (ms) — ping under proxy idle timeouts. */
const SSE_HEARTBEAT_MS = 25_000;

/** Attention kinds that, when AFK, get routed to the phone via the orchestrator. */
const PHONE_ROUTED_KINDS: ReadonlySet<AttentionKind> = new Set([
  AttentionKind.PERMISSION,
  AttentionKind.QUESTION,
  AttentionKind.PLAN,
]);

export const deviceRoutes = new Hono<DeviceHonoEnv>();

// --- PAIR (no device auth; uses a single-use pairing token) -------------------
deviceRoutes.post(DeviceApiRoute.PAIR, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    pairingToken?: unknown;
    os?: unknown;
    hostname?: unknown;
  };
  const pairingToken = typeof body.pairingToken === 'string' ? body.pairingToken : '';
  if (!pairingToken) {
    return c.json({ error: 'missing_pairing_token' }, 400);
  }
  const os = typeof body.os === 'string' ? body.os : undefined;
  const hostname = typeof body.hostname === 'string' ? body.hostname : undefined;

  // Mint the device token FIRST, store only its peppered hash. The raw token is
  // returned once and never persisted.
  const deviceToken = generateDeviceToken();
  const created = await consumePairingTokenAndCreateDevice({
    pairingTokenHash: hashToken(pairingToken),
    deviceTokenHash: hashToken(deviceToken),
    os,
    hostname,
  });
  if (!created) {
    // Unknown / expired / already-used token. Generic message (no oracle).
    return c.json({ error: 'invalid_pairing_token' }, 401);
  }
  return c.json({ deviceToken, deviceId: created.deviceId });
});

// --- everything below requires a device_token --------------------------------
deviceRoutes.use(`${DeviceApiRoute.ATTENTION}`, requireDevice);
deviceRoutes.use(`${DeviceApiRoute.DECISIONS}`, requireDevice);
deviceRoutes.use(`${DeviceApiRoute.EVENTS}`, requireDevice);
deviceRoutes.use(`${DeviceApiRoute.HEARTBEAT}`, requireDevice);
deviceRoutes.use(`${DeviceApiRoute.STATE}`, requireDevice);

function device(c: Context<DeviceHonoEnv>): DeviceAuth {
  return c.get(DEVICE_CTX_KEY);
}

// --- ATTENTION ----------------------------------------------------------------
deviceRoutes.post(DeviceApiRoute.ATTENTION, async (c) => {
  const auth = device(c);
  const payload = await c.req.json().catch(() => null);
  const events: unknown[] = Array.isArray(payload)
    ? payload
    : payload && Array.isArray((payload as { events?: unknown }).events)
      ? ((payload as { events: unknown[] }).events)
      : [];

  if (events.length === 0) {
    return c.json({ error: 'no_events' }, 400);
  }

  const accepted: string[] = [];
  const rejected: number[] = [];

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!isAttentionEvent(e)) {
      rejected.push(i);
      continue;
    }
    try {
      // Ensure the session exists (device may report a new session here).
      await upsertSession({
        sessionId: e.sessionId,
        deviceId: auth.deviceId,
        accountId: auth.accountId,
        state:
          e.kind === AttentionKind.TURN_COMPLETE
            ? SessionState.IDLE
            : SessionState.WAITING,
      });
      const stored = await insertAttentionEvent({
        deviceId: auth.deviceId,
        accountId: auth.accountId,
        event: e,
      });
      accepted.push(stored.id);
      await maybeRouteToPhone(stored, auth);
    } catch (err) {
      console.error('[device/attention] store failed', err);
      rejected.push(i);
    }
  }

  return c.json({ accepted, rejected });
});

/**
 * If the session is AFK and this is a phone-routable kind, send a notification
 * to the phone. We reuse the orchestrator's transport; the actual outbound
 * framing is a concise nudge. The verdict comes back later via the orchestrator
 * resolving the attention and the device long-poll waking.
 */
async function maybeRouteToPhone(
  event: AttentionEvent,
  auth: DeviceAuth,
): Promise<void> {
  if (!PHONE_ROUTED_KINDS.has(event.kind)) return;
  const session = await getSessionForDevice({
    sessionId: event.sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
  });
  if (!session || session.afk !== AfkState.ON) return;

  // AFK + phone-routable: spin up an assistant TURN to decide how to surface this
  // to the user. The assistant owns phone resolution + notification framing (with
  // a static-notification fallback inside the turn). Fire-and-forget so the
  // device's POST is not held on an LLM turn; the turn handles its own errors.
  void runAgentEventTurn(event, auth.accountId, getTransport()).catch((err) => {
    console.error('[device/attention] agent-event turn failed', err);
  });
}

// --- DECISIONS (LONG-POLL) ----------------------------------------------------
deviceRoutes.get(DeviceApiRoute.DECISIONS, async (c) => {
  const auth = device(c);
  const sessionId = c.req.query('sessionId');
  const since = c.req.query('since');
  if (!sessionId) {
    return c.json({ error: 'missing_session_id' }, 400);
  }

  // Scope check: the session must belong to this device/account.
  const session = await getSessionForDevice({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
  });
  if (!session) {
    return c.json({ error: 'unknown_session' }, 404);
  }

  // Fast path: already-resolved decisions since the cursor. The response
  // carries the requestIds map (attentionId -> Channels request_id) the device
  // needs to relay a permission verdict, plus an advanced `since` cursor.
  const initial = await listDecisionsForSession({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
    since,
  });
  if (initial.decisions.length > 0) {
    return c.json(initial);
  }

  // Slow path: park on LISTEN/NOTIFY until a decision lands or we time out.
  await ensureListener();
  const woken = await waitForDecision(sessionId, LONG_POLL_MS);
  if (!woken) {
    // Timeout: fail-closed — empty list, never a default allow.
    return c.json({ decisions: [], requestIds: {} });
  }

  // Re-query: the NOTIFY is only a wake signal; the DB is the source of truth.
  const fresh = await listDecisionsForSession({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
    since,
  });
  return c.json(fresh);
});

// --- EVENTS (SSE push: decisions + session-message steers) --------------------
// Replaces the device's decision polling: the plugin opens ONE long-lived stream
// and reacts to pushed events (driven by LISTEN/NOTIFY). On (re)connect we replay
// anything since the device's cursor, then stream live — at-least-once, fail-closed.
deviceRoutes.get(DeviceApiRoute.EVENTS, async (c) => {
  const auth = device(c);
  const sessionId = c.req.query('sessionId');
  const since0 = c.req.query('since');
  if (!sessionId) {
    return c.json({ error: 'missing_session_id' }, 400);
  }
  const session = await getSessionForDevice({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
  });
  if (!session) {
    return c.json({ error: 'unknown_session' }, 404);
  }
  await ensureListener();

  return streamSSE(c, async (stream) => {
    let since = since0; // decisions cursor (ISO resolved_at); advances as we emit
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });

    // Emit pending decisions (since cursor) + undelivered steers, then mark
    // steers delivered. The device's applyDecision stays the verdict arbiter.
    const flush = async (): Promise<void> => {
      const dec = await listDecisionsForSession({
        sessionId,
        deviceId: auth.deviceId,
        accountId: auth.accountId,
        since,
      });
      if (dec.decisions.length > 0) {
        await stream.writeSSE({
          event: 'decisions',
          data: JSON.stringify({
            decisions: dec.decisions,
            requestIds: dec.requestIds,
            since: dec.since,
          }),
        });
        if (dec.since) since = dec.since;
      }
      const msgs = await listUndeliveredSessionMessages({
        sessionId,
        deviceId: auth.deviceId,
        accountId: auth.accountId,
      });
      if (msgs.length > 0) {
        await stream.writeSSE({ event: 'session_messages', data: JSON.stringify({ messages: msgs }) });
        await markSessionMessagesDelivered(msgs.map((m) => m.id));
      }
    };

    // Catch-up on connect, then stream live. waitForSessionEvent wakes on a
    // decision OR a steer for this session; on timeout we ping to stay alive.
    await flush();
    while (!aborted && !c.req.raw.signal.aborted) {
      const woken = await waitForSessionEvent(sessionId, SSE_HEARTBEAT_MS, c.req.raw.signal);
      if (aborted || c.req.raw.signal.aborted) break;
      // Honor a mid-stream device revoke/disable: the stream authed once at connect,
      // but the killswitch must still cut delivery (the old long-poll re-authed on
      // every poll). Breaking forces a reconnect back through requireDevice.
      const ds = await getDeviceState({ deviceId: auth.deviceId, accountId: auth.accountId });
      if (!ds.enabled) break;
      // Re-query EVERY iteration (not only on wake): a NOTIFY firing in the window
      // between flush() returning and the next waiter registering would otherwise
      // be stranded until an unrelated NOTIFY. The timeout path bounds worst-case
      // delivery latency to one heartbeat (matches the old long-poll's behavior).
      await flush();
      if (!woken) await stream.writeSSE({ event: 'ping', data: '{}' });
    }
  });
});

// --- HEARTBEAT ----------------------------------------------------------------
deviceRoutes.post(DeviceApiRoute.HEARTBEAT, async (c) => {
  const auth = device(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionId?: unknown;
    cwd?: unknown;
  };
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    return c.json({ error: 'missing_session_id' }, 400);
  }
  const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;

  // Upsert so a heartbeat can register a brand-new session, then touch it.
  await upsertSession({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
    cwd,
  });
  const ok = await touchSession({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
  });
  return c.json({ ok });
});

// --- STATE: GET (killswitch + state probe) ------------------------------------
// enabled = device not revoked AND not remotely disabled. afk/grant come from
// the device's most-recent live session. The device polls this to honor a
// remote killswitch (disable from the dashboard with no credential rotation).
deviceRoutes.get(DeviceApiRoute.STATE, async (c) => {
  const auth = device(c);
  const state = await getDeviceState({
    deviceId: auth.deviceId,
    accountId: auth.accountId,
  });
  return c.json(state);
});

// --- STATE: POST (afk / grant) ------------------------------------------------
// sessionId is OPTIONAL. With a sessionId, update that one session. WITHOUT one
// (the CLI `imsg afk/grant` device-wide path), apply afk/grant to ALL the
// device's live sessions. FULL is reachable here only via the authenticated
// device path, never via the LLM (see orchestrator validateAction).
deviceRoutes.post(DeviceApiRoute.STATE, async (c) => {
  const auth = device(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionId?: unknown;
    afk?: unknown;
    grant?: unknown;
  };
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const afk = isAfkState(body.afk) ? body.afk : undefined;
  const grant = isGrantLevel(body.grant) ? body.grant : undefined;

  // DEVICE-WIDE: no sessionId -> apply across all the device's live sessions.
  if (!sessionId) {
    if (afk === undefined && grant === undefined) {
      return c.json({ error: 'nothing_to_update' }, 400);
    }
    const sessions = await updateSessionStateForDevice({
      deviceId: auth.deviceId,
      accountId: auth.accountId,
      afk,
      grant,
    });
    return c.json({ sessions });
  }

  // SINGLE SESSION.
  if (afk === undefined && grant === undefined) {
    // Nothing to change — return current state (or 404 if unknown).
    const current = await getSessionForDevice({
      sessionId,
      deviceId: auth.deviceId,
      accountId: auth.accountId,
    });
    return current
      ? c.json({ session: current })
      : c.json({ error: 'unknown_session' }, 404);
  }

  // Ensure the session exists, then apply the state change.
  await upsertSession({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
  });
  const updated = await updateSessionState({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
    afk,
    grant,
  });
  return updated
    ? c.json({ session: updated })
    : c.json({ error: 'unknown_session' }, 404);
});
