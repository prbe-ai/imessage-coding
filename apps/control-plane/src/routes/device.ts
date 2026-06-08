/**
 * DEVICE API — the plugin's interface to the control plane.
 *
 * All routes except PAIR require a Bearer device_token (requireDevice) and are
 * scoped to the authenticated device + account. PAIR exchanges a single-use
 * pairing token for a device_token (returned exactly once).
 *
 *   POST /api/device/pair       {pairingToken, os?, hostname?} -> {deviceToken}
 *   POST /api/device/attention  AttentionEvent[]               -> {accepted}
 *   POST /api/device/message    {sessionId, text}              -> {relayed}   (fire-and-forget status)
 *   GET  /api/device/events     ?sessionId (SSE)               -> session inbox + afk
 *   POST /api/device/ack        {sessionId, ids}               -> {acked}
 *   POST /api/device/heartbeat  {sessionId, cwd?}              -> {ok}
 *   POST /api/device/state      {afk?}                         -> {device:{enabled,afk}}
 *   GET  /api/device/state                                     -> {enabled, afk}
 *
 * The device subscribes to EVENTS (SSE), which pushes the session inbox — one
 * row per thing to deliver into the session (a `reply` to inject, or a permission
 * `verdict` to relay) — plus afk on change. The device injects each row and
 * confirms via ACK; the server sets delivered_at on that ACK and re-serves until
 * then (at-least-once + idempotent dedup by id). afk is MACHINE-WIDE (stored on
 * the device, not the session): POST /state writes the authenticated device's afk
 * (the CLI `imsg afk` toggle); any sessionId in the body is ignored. GET /state is
 * the remote killswitch probe: enabled = (revoked_at IS NULL AND disabled_at IS
 * NULL) for the device.
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import {
  AfkState,
  AttentionKind,
  DecisionBehavior,
  DeviceApiRoute,
  SESSION_TITLE_MAX_LEN,
  SessionState,
  SseEvent,
  cleanSessionTitle,
  isActivityBatchBody,
  isAfkState,
  isAgentKind,
  isAttentionEvent,
  isUuid,
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
  applySessionStatePing,
  findVerdictForRequest,
  getDeviceState,
  getSessionForDevice,
  insertAttentionEvent,
  insertSessionActivity,
  listUndeliveredInbox,
  markInboxDelivered,
  resolveAttention,
  setDeviceAfk,
  setTitle,
  touchSession,
  upsertSession,
} from '../db/repo.ts';
import {
  ensureListener,
  waitForSessionEvent,
  waitForSessionOrDeviceEvent,
} from '../db/listener.ts';
import { streamSSE } from 'hono/streaming';
import { getTransport } from '../transport.ts';
import { relayAgentMessage, runAgentEventTurn } from '../orchestrator/index.ts';
import {
  PERMISSION_DEADLINE_MS,
  assertDeadlineBelowHookTimeout,
  deadlineDenyResponse,
  verdictResponse,
} from './permission.ts';

/** SSE keepalive cadence (ms) — ping well under the Fly proxy idle ceiling
 *  (~60s) so an idle stream isn't dropped mid-flight (the recurring "operation
 *  timed out" reconnects). Also bounds worst-case re-flush latency to one beat. */
const SSE_HEARTBEAT_MS = 15_000;

/** Max activity events accepted in one POST /api/device/activity (device chunks at 500). */
const MAX_ACTIVITY_BATCH = 2_000;

/** Attention kinds that, when AFK, get routed to the phone via the orchestrator. */
const PHONE_ROUTED_KINDS: ReadonlySet<AttentionKind> = new Set([
  AttentionKind.PERMISSION,
  AttentionKind.QUESTION,
  AttentionKind.PLAN,
]);

/**
 * STATE-ONLY kinds: they ONLY drive sessions.state and carry no attention to
 * surface. They must NOT create an attention_events row (those join the
 * unresolved pile the orchestrator reads) and are never routed to the phone.
 *   TURN_START    -> active     TURN_COMPLETE -> idle (guarded)    BLOCKED -> waiting
 */
const STATE_ONLY_KINDS: ReadonlySet<AttentionKind> = new Set([
  AttentionKind.TURN_START,
  AttentionKind.TURN_COMPLETE,
  AttentionKind.BLOCKED,
]);

/**
 * Per-session min-interval between fire-and-forget status relays. A status relay
 * is unbounded (model-driven) and each one is an LLM turn + an outbound text, so a
 * runaway agent loop calling `message_user` could flood the user's phone and rack
 * up turns. This caps the blast radius: a sane agent reports on task completion,
 * far under this rate; excess is DROPPED (not queued). In-memory + best-effort
 * (resets on deploy; single-instance — a multi-instance deploy would move this to
 * a shared store). Keyed by session; bounded by real sessions (must pass the
 * tenant-scoped getSessionForDevice check below).
 */
const STATUS_RELAY_MIN_INTERVAL_MS = 1_000;
const lastStatusRelayAt = new Map<string, number>();

// `isUuid` (shared) guards query/body ids BEFORE they reach a UUID column: an
// UPDATE/SELECT with a non-UUID string otherwise throws Postgres 22P02
// (`invalid input syntax for type uuid`), surfacing as a 500 instead of a 4xx.

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
deviceRoutes.use(`${DeviceApiRoute.MESSAGE}`, requireDevice);
deviceRoutes.use(`${DeviceApiRoute.SESSION_TITLE}`, requireDevice);
deviceRoutes.use(`${DeviceApiRoute.ACTIVITY}`, requireDevice);
deviceRoutes.use(`${DeviceApiRoute.EVENTS}`, requireDevice);
deviceRoutes.use(`${DeviceApiRoute.ACK}`, requireDevice);
deviceRoutes.use(`${DeviceApiRoute.HEARTBEAT}`, requireDevice);
deviceRoutes.use(`${DeviceApiRoute.STATE}`, requireDevice);
deviceRoutes.use(`${DeviceApiRoute.PERMISSION}`, requireDevice);

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
      // STATE-ONLY kinds just drive sessions.state — no attention row, no phone.
      // applySessionStatePing is a single conditional UPDATE: it never creates or
      // revives a session, and TURN_COMPLETE→idle defers to the unresolved
      // attention pile (so an AFK turn parked on a phone reply stays WAITING).
      if (STATE_ONLY_KINDS.has(e.kind)) {
        const state =
          e.kind === AttentionKind.TURN_START
            ? SessionState.ACTIVE
            : e.kind === AttentionKind.TURN_COMPLETE
              ? SessionState.IDLE
              : SessionState.WAITING; // BLOCKED
        await applySessionStatePing({
          sessionId: e.sessionId,
          accountId: auth.accountId,
          state,
          requireNoPending: e.kind === AttentionKind.TURN_COMPLETE,
        });
        accepted.push(e.id);
        continue;
      }

      // Real attention (permission/question/plan): WAITING + persist + maybe phone.
      // Ensure the session exists (device may report a new session here).
      await upsertSession({
        sessionId: e.sessionId,
        deviceId: auth.deviceId,
        accountId: auth.accountId,
        state: SessionState.WAITING,
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

// --- MESSAGE (fire-and-forget agent→user status / result) ---------------------
// The SPLIT: a status message is NOT an attention — no `resolved` lifecycle, it
// never joins the pending pile. We relay it (AFK-gated) through a notify-only
// server-agent turn and drop it. Tenant-scoped + best-effort; the device POST is
// not held on the LLM turn.
deviceRoutes.post(DeviceApiRoute.MESSAGE, async (c) => {
  const auth = device(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionId?: unknown;
    text?: unknown;
    expectsReply?: unknown;
    verbatim?: unknown;
  };
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  // `expectsReply` is the demoted `expect_reply`: a HINT (not a lock) that the agent
  // is awaiting an answer, so the orchestrator surfaces the relay as a question.
  const expectsReply = body.expectsReply === true;
  // `verbatim`: send the agent's text to the user AS-IS, bypassing the orchestrator LLM
  // (no summarizing). Clamped to one screenful + attributed in relayAgentMessage.
  const verbatim = body.verbatim === true;
  if (!sessionId) return c.json({ error: 'missing_session_id' }, 400);
  if (!isUuid(sessionId)) return c.json({ error: 'invalid_session_id' }, 400);
  if (!text) return c.json({ error: 'missing_text' }, 400);

  // Status is fire-and-forget: relay only for an EXISTING, live session — and do
  // NOT upsert here. upsertSession revives an `ended` row (ON CONFLICT COALESCE),
  // so a late/duplicate/retried status POST would resurrect a reaped session into
  // the live list. Scope-check first (tenant isolation); drop silently if the
  // session is unknown or already ended.
  const session = await getSessionForDevice({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
  });
  if (!session) {
    return c.json({ error: 'unknown_session' }, 404);
  }
  if (session.state === SessionState.ENDED) {
    return c.json({ relayed: false });
  }
  // AFK-gate (mirrors maybeRouteToPhone): at the keyboard the user sees the agent
  // directly, so don't relay. Dropped, not an error.
  if (session.afk !== AfkState.ON) {
    return c.json({ relayed: false });
  }
  // Throttle runaway status loops (see STATUS_RELAY_MIN_INTERVAL_MS): drop, don't queue.
  const now = Date.now();
  if (now - (lastStatusRelayAt.get(sessionId) ?? 0) < STATUS_RELAY_MIN_INTERVAL_MS) {
    return c.json({ relayed: false, reason: 'throttled' });
  }
  lastStatusRelayAt.set(sessionId, now);

  void relayAgentMessage(
    { sessionId, text, expectsReply, verbatim },
    auth.accountId,
    getTransport(),
  ).catch(
    (err) => {
      console.error('[device/message] relay turn failed', err);
    },
  );
  return c.json({ relayed: true });
});

// --- SESSION_TITLE (agent rename_session) -------------------------------------
// The agent's `rename_session` tool POSTs here to set this session's display
// name. Mirrors the dashboard inline-edit (POST /api/home/session-title) and the
// orchestrator's rename tool: all write the single `title` column directly
// (last-writer-wins). The rename can't be clobbered by the next ≤10s beat because
// the device ships its auto-title edge-triggered (only on change), never
// re-asserted every beat. An empty name is a no-op (a label is never blanked).
// NOT AFK-gated: a label is session metadata (like cwd/title), not user-facing
// comms, so it applies at the keyboard too.
deviceRoutes.post(DeviceApiRoute.SESSION_TITLE, async (c) => {
  const auth = device(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionId?: unknown;
    title?: unknown;
  };
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) return c.json({ error: 'missing_session_id' }, 400);
  if (!isUuid(sessionId)) return c.json({ error: 'invalid_session_id' }, 400);
  // Clean + clamp server-side (defense-in-depth; the device cleans too). Empty
  // after cleaning is a no-op — a label is never blanked.
  const title = cleanSessionTitle(typeof body.title === 'string' ? body.title : '');
  if (!title) return c.json({ error: 'empty_title' }, 400);
  // Scope check: the session must belong to this device/account (tenant isolation).
  const session = await getSessionForDevice({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
  });
  if (!session) return c.json({ error: 'unknown_session' }, 404);
  // Honor the write's own scope result too — closes the TOCTOU if the row is
  // reaped between the ownership read and the update.
  const updated = await setTitle({ sessionId, accountId: auth.accountId, title });
  if (!updated) return c.json({ error: 'unknown_session' }, 404);
  return c.json({ title });
});

// --- PERMISSION (BLOCKING approve-and-resume for Codex) ------------------------
// Codex has NO native verdict-push channel (unlike CC's Channels permission
// capability). Its `PermissionRequest` hook POSTs the pending destructive tool
// here and BLOCKS on the HTTP response: when we return {behavior}, the hook
// allows/denies the parked command. We do NOT decide allow ourselves — we SURFACE
// the request through the SAME machinery CC uses (a PERMISSION attention + the
// orchestrator's tap-back-able notification) and WAIT for the user's verdict,
// which the UNCHANGED CC path (orchestrator → resolveAttention) writes as a
// session_inbox row kind='verdict'. The deterministic binding gate (safety.ts)
// applies identically.
//
// Sequence: surface (insertAttentionEvent + runAgentEventTurn) → wait (park on
// the session's NOTIFY, re-query for the verdict) → return verdict / deadline.
//
// DEADLINE INVARIANT: if no verdict lands within PERMISSION_DEADLINE_MS we return
// an EXPLICIT deny — never a hang, never an allow. That deadline MUST be shorter
// than the Codex hook's own timeout (see permission.ts) so a no-answer is a clean
// remote deny rather than the hook lapsing into the unattended LOCAL prompt.
deviceRoutes.post(DeviceApiRoute.PERMISSION, async (c) => {
  const auth = device(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionId?: unknown;
    toolName?: unknown;
    summary?: unknown;
  };
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) return c.json({ error: 'missing_session_id' }, 400);
  if (!isUuid(sessionId)) return c.json({ error: 'invalid_session_id' }, 400);
  const toolName = typeof body.toolName === 'string' ? body.toolName.trim() : '';
  if (!toolName) return c.json({ error: 'missing_tool_name' }, 400);
  // `summary` is the one-line description of what the tool will do (the device
  // already reduces it). Optional; clamped at the write path (insertAttentionEvent).
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';

  // Ensure the session exists (the Codex hook may name a session the heartbeat
  // hasn't registered yet), like the ATTENTION route. WAITING: the agent is
  // parked on this permission until the verdict lands.
  await upsertSession({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
    state: SessionState.WAITING,
  });

  // SURFACE: record a PERMISSION attention via the SAME write path CC uses. The
  // server mints request_id — the binding the verdict row carries back (CC's
  // request_id is the Channels protocol id; for Codex there is no such channel,
  // so the server owns it and reads its own verdict by it). This is what lets the
  // unchanged orchestrator/resolveAttention produce a matchable verdict.
  const requestId = randomUUID();
  let attention: AttentionEvent;
  try {
    attention = await insertAttentionEvent({
      deviceId: auth.deviceId,
      accountId: auth.accountId,
      event: {
        id: randomUUID(), // overwritten by the DB default; required by the type
        deviceId: auth.deviceId,
        sessionId,
        kind: AttentionKind.PERMISSION,
        toolName,
        ...(summary ? { description: summary } : {}),
        requestId,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[device/permission] store failed', err);
    return c.json({ error: 'store_failed' }, 500);
  }

  // Surface to the phone through the orchestrator — the EXACT CC path: a
  // destructive permission gets the code-generated composeNotification with a
  // notify_message_id binding (notifyStatic → setAttentionNotifyMessageId), so a
  // tap-back binds deterministically and resolves through safety.ts. NOT
  // AFK-gated: the Codex hook blocks unconditionally, so the verdict must always
  // be surfaced. Fire-and-forget (the turn owns its own errors); we then WAIT for
  // the verdict the user issues, independent of how it was surfaced.
  void runAgentEventTurn(attention, auth.accountId, getTransport()).catch((err) => {
    console.error('[device/permission] surface turn failed', err);
  });

  // WAIT: block until the verdict row (kind='verdict', this request_id) lands or
  // the deadline fires. Reuse the listener's session waiter (woken by the
  // session_inbox INSERT NOTIFY that resolveAttention's verdict triggers),
  // park-before-query against findVerdictForRequest — the same pattern as
  // waitForDelivered, but the verdict's EXISTENCE is the signal (no ACK needed:
  // the blocking hook is the consumer, not the device inbox injector).
  //
  // The wait is driven off ONE AbortController so a client disconnect tears the
  // waiter down immediately (no leak); the deadline is a hard floor; and on every
  // path we re-query the DB (the arbiter of truth) rather than trust the NOTIFY.
  await ensureListener();
  // Guard the deadline invariant at the call site (throws loud if a future edit
  // raises the deadline above the hook timeout). Returns the validated deadline.
  const deadlineMs = assertDeadlineBelowHookTimeout(PERMISSION_DEADLINE_MS);
  const startedAt = Date.now();
  const controller = new AbortController();
  const onClientAbort = (): void => controller.abort();
  c.req.raw.signal.addEventListener('abort', onClientAbort, { once: true });

  try {
    // Park the waiter BEFORE the first re-check (park-before-query: a verdict that
    // lands between two checks must not be missed).
    while (!controller.signal.aborted && !c.req.raw.signal.aborted) {
      const remaining = deadlineMs - (Date.now() - startedAt);
      // A verdict landing in the same instant the deadline fires resolves to DENY
      // by design (fail-safe: deny-over-allow at the boundary) — do NOT "fix" this
      // into an allow.
      if (remaining <= 0) break; // deadline → explicit deny below
      const parked = waitForSessionEvent(sessionId, remaining, controller.signal);
      const existing = await findVerdictForRequest({
        sessionId,
        accountId: auth.accountId,
        requestId,
      });
      if (existing) {
        controller.abort(); // tear down the parked waiter
        return c.json(verdictResponse(existing));
      }
      // No verdict yet: wait for the next session NOTIFY (or the remaining
      // deadline / a client disconnect), then re-query.
      await parked;
      const after = await findVerdictForRequest({
        sessionId,
        accountId: auth.accountId,
        requestId,
      });
      if (after) {
        controller.abort();
        return c.json(verdictResponse(after));
      }
    }

    // DEADLINE (or client disconnect): return an EXPLICIT deny — never a hang,
    // never an allow. Resolve the now-orphaned attention as DENY so it doesn't
    // linger in the pending pile and a late tap-back can't approve a command that
    // already returned (idempotent: resolveAttention only the first resolve wins,
    // so a verdict that beat us to it has already returned above).
    await resolveAttention({
      accountId: auth.accountId,
      attentionId: attention.id,
      behavior: DecisionBehavior.DENY,
    }).catch((err) => {
      console.error('[device/permission] deadline deny cleanup failed', err);
    });
    return c.json(deadlineDenyResponse());
  } finally {
    controller.abort(); // no leaked waiter on any path (verdict, deadline, abort)
    c.req.raw.signal.removeEventListener('abort', onClientAbort);
  }
});

// --- ACTIVITY (the transcript tap) --------------------------------------------
// A lightweight, per-block stream of what a session is DOING — shipped by the
// device's tap daemon in realtime (killswitch-gated, not AFK-gated). We
// register/refresh the session (the tap may report a brand-new one before the
// heartbeat) and bulk-insert the events (idempotent on transcript position). No
// phone routing: this is pull-only context the orchestrator reads (the snapshot +
// get_session_data), not an attention to surface.
deviceRoutes.post(DeviceApiRoute.ACTIVITY, async (c) => {
  const auth = device(c);
  const body = await c.req.json().catch(() => null);
  if (!isActivityBatchBody(body)) {
    return c.json({ error: 'invalid_activity_batch' }, 400);
  }
  if (body.events.length === 0) {
    return c.json({ accepted: 0 });
  }
  // Hard bound: the device chunks at 500/batch; reject anything wildly larger so a
  // forged/buggy device can't push an unbounded batch into one query.
  if (body.events.length > MAX_ACTIVITY_BATCH) {
    return c.json({ error: 'batch_too_large' }, 400);
  }
  try {
    // Ensure the session exists (cwd = the project dir) — the tap may report a
    // brand-new session before its first heartbeat. No state override (keep a
    // WAITING/IDLE set by an attention event), and reviveIfEnded:false so a late
    // tail-flush from a dying tap can't resurrect a reaped session — that would
    // re-arm the reaper and double-fire the "session stopped" notice. A genuine
    // return-from-dead comes back via the heartbeat, which does revive.
    await upsertSession({
      sessionId: body.sessionId,
      deviceId: auth.deviceId,
      accountId: auth.accountId,
      cwd: body.cwd,
      // Label the row from the tap too (it knows its IMSG_AGENT_KIND), so a codex
      // session is correctly agented from its first activity, before any heartbeat.
      agent: body.agent,
      reviveIfEnded: false,
    });
    const accepted = await insertSessionActivity({
      deviceId: auth.deviceId,
      accountId: auth.accountId,
      sessionId: body.sessionId,
      events: body.events,
    });
    return c.json({ accepted });
  } catch (err) {
    console.error('[device/activity] store failed', err);
    return c.json({ error: 'store_failed' }, 500);
  }
});

// --- EVENTS (SSE push: the session inbox + afk state) -------------------------
// The plugin opens ONE long-lived stream and reacts to pushed events (driven by
// LISTEN/NOTIFY). On every wake it flushes the session's undelivered inbox rows
// (a reply or a permission verdict) + afk on change; rows re-serve until the
// device ACKs them — at-least-once, deduped to once into the session.
deviceRoutes.get(DeviceApiRoute.EVENTS, async (c) => {
  const auth = device(c);
  const sessionId = c.req.query('sessionId');
  if (!sessionId) {
    return c.json({ error: 'missing_session_id' }, 400);
  }
  if (!isUuid(sessionId)) {
    return c.json({ error: 'invalid_session_id' }, 400);
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
    // Last afk pushed for THIS session; undefined → emit the current value on
    // the first flush so a reconnecting device re-syncs even if it missed a
    // change while disconnected.
    let lastAfk: typeof session.afk | undefined;
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });

    // Flush the session's undelivered inbox rows (a `reply` to inject, or a
    // permission `verdict` to relay) + afk on change. Rows are NOT marked here:
    // delivered_at is set only on the device's ACK, so a dropped frame is
    // re-served on the next flush (at-least-once; the device dedups by id).
    const flush = async (): Promise<void> => {
      const items = await listUndeliveredInbox({
        sessionId,
        deviceId: auth.deviceId,
        accountId: auth.accountId,
      });
      if (items.length > 0) {
        await stream.writeSSE({ event: SseEvent.INBOX, data: JSON.stringify({ items }) });
      }
      // Push afk on change so a dashboard/CLI toggle reaches the device's
      // PreToolUse hook (which reads the local state file). Re-query for the
      // freshest value; the session may have ended mid-stream (cur undefined).
      const cur = await getSessionForDevice({
        sessionId,
        deviceId: auth.deviceId,
        accountId: auth.accountId,
      });
      if (cur && cur.afk !== lastAfk) {
        await stream.writeSSE({
          event: SseEvent.STATE,
          data: JSON.stringify({ afk: cur.afk }),
        });
        lastAfk = cur.afk;
      }
    };

    // Catch-up on connect, then stream live. Wake on a new inbox row for THIS
    // session OR a machine-wide afk toggle on THIS device (device_state),
    // so a dashboard/CLI device toggle reaches every session's hook sub-second.
    // On timeout we ping to stay alive.
    await flush();
    while (!aborted && !c.req.raw.signal.aborted) {
      const woken = await waitForSessionOrDeviceEvent(
        sessionId,
        auth.deviceId,
        SSE_HEARTBEAT_MS,
        c.req.raw.signal,
      );
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
      if (!woken) await stream.writeSSE({ event: SseEvent.PING, data: '{}' });
    }
  });
});

// --- ACK ----------------------------------------------------------------------
// The device confirms it injected inbox rows into the session (by id). We set
// delivered_at so the SSE flush stops re-serving them — turning delivery from
// at-most-once (a dropped frame lost the row) into at-least-once + idempotent
// dedup (the device skips re-injection, the server skips re-send). Session-scoped:
// an ack can only touch this device's own rows. Always 200 with the subset
// actually flipped (idempotent).
deviceRoutes.post(DeviceApiRoute.ACK, async (c) => {
  const auth = device(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionId?: unknown;
    ids?: unknown;
  };
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    return c.json({ error: 'missing_session_id' }, 400);
  }
  // Validate UUIDs here: the repo casts to ::uuid[], and a malformed id
  // (old/buggy client) would otherwise raise an unhandled 500. Drop non-UUIDs
  // silently (consistent with the idempotent "subset actually flipped" contract).
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === 'string' && isUuid(x))
    : [];
  if (ids.length === 0) {
    return c.json({ acked: [] });
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
  const acked = await markInboxDelivered({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
    ids,
  });
  return c.json({ acked });
});

// --- HEARTBEAT ----------------------------------------------------------------
deviceRoutes.post(DeviceApiRoute.HEARTBEAT, async (c) => {
  const auth = device(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionId?: unknown;
    cwd?: unknown;
    title?: unknown;
    agent?: unknown;
    afk?: unknown;
    afkDirty?: unknown;
  };
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    return c.json({ error: 'missing_session_id' }, 400);
  }
  // sessions.id is a UUID column. The id now comes from CLAUDE_CODE_SESSION_ID
  // (CC-owned), not our randomUUID(), so guard it like the SSE/decisions/ack
  // routes do — a non-UUID would otherwise throw an invalid-uuid 500 in the
  // INSERT on every heartbeat instead of a clean 400.
  if (!isUuid(sessionId)) {
    return c.json({ error: 'invalid_session_id' }, 400);
  }
  const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
  // Re-clamp the device-capped title: a forged/buggy client must not bloat the
  // row. The empty string maps to undefined so it never overwrites a real title.
  const rawTitle = typeof body.title === 'string' ? body.title.slice(0, SESSION_TITLE_MAX_LEN) : '';
  const title = rawTitle.trim() ? rawTitle : undefined;
  // Which coding agent reported this heartbeat. Validate at the trust boundary;
  // an absent (old plugin) or invalid value falls through to undefined so
  // upsertSession applies the AgentKind.CLAUDE_CODE default — back-compat intact.
  const agent = isAgentKind(body.agent) ? body.agent : undefined;

  // Upsert so a heartbeat can register a brand-new session, then touch it.
  await upsertSession({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
    cwd,
    title,
    agent,
  });
  const ok = await touchSession({
    sessionId,
    deviceId: auth.deviceId,
    accountId: auth.accountId,
  });

  // Dirty-afk reconcile: the device only sends afk while a local toggle is un-acked
  // (its POST /api/device/state may have been lost). The device is authoritative
  // for its OWN machine afk, so adopt it — this is what makes the toggle (and the
  // afk-off wipe) reliable without a retry queue. A non-dirty heartbeat sends no
  // afk, so a steady beat never clobbers a dashboard change. Echo the resulting afk
  // so the device can clear its dirty flag. Only touch the DB when it actually
  // differs, so a no-op heartbeat doesn't spuriously fire the device_state NOTIFY.
  if (body.afkDirty === true && isAfkState(body.afk)) {
    const state = await getDeviceState({ deviceId: auth.deviceId, accountId: auth.accountId });
    if (state.afk !== body.afk) {
      await setDeviceAfk({ deviceId: auth.deviceId, accountId: auth.accountId, afk: body.afk });
    }
    return c.json({ ok, afk: body.afk });
  }
  return c.json({ ok });
});

// --- STATE: GET (killswitch + state probe) ------------------------------------
// enabled = device not revoked AND not remotely disabled. afk comes from the
// device row. The device polls this to honor a remote killswitch (disable from
// the dashboard with no credential rotation).
deviceRoutes.get(DeviceApiRoute.STATE, async (c) => {
  const auth = device(c);
  const state = await getDeviceState({
    deviceId: auth.deviceId,
    accountId: auth.accountId,
  });
  return c.json(state);
});

// --- STATE: POST (afk) --------------------------------------------------------
// afk is MACHINE-WIDE: it lives on the device row (the single source of truth the
// PreToolUse hook honors), so a toggle here writes the authenticated device — NOT
// one session. Any `sessionId` in the body is ignored (the CLI `imsg afk` already
// sends none; the field is legacy).
deviceRoutes.post(DeviceApiRoute.STATE, async (c) => {
  const auth = device(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    afk?: unknown;
  };
  const afk = isAfkState(body.afk) ? body.afk : undefined;
  if (afk === undefined) {
    return c.json({ error: 'nothing_to_update' }, 400);
  }

  await setDeviceAfk({ deviceId: auth.deviceId, accountId: auth.accountId, afk });
  // Echo the device's resulting machine-wide state (the CLI only checks ok).
  const state = await getDeviceState({ deviceId: auth.deviceId, accountId: auth.accountId });
  return c.json({ device: state });
});
