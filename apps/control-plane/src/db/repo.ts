/**
 * Account-scoped data access for the control plane.
 *
 * Every read/write is keyed by account_id (the tenant boundary) and, for the
 * device API, additionally constrained to the authenticated device's own
 * sessions. The mapping functions translate snake_case DB rows into the
 * camelCase @imsg/shared wire types so the rest of the app never touches column
 * names.
 */
import {
  AfkState,
  AgentKind,
  GrantLevel,
  SessionState,
  type AttentionEvent,
  type AttentionKind,
  type Decision,
  type DecisionBehavior,
  type DecisionSource,
  type SessionInfo,
} from '@imsg/shared';
import { query, queryOne, withTransaction } from './pool.ts';

// --- row shapes ---------------------------------------------------------------

interface AccountRow {
  id: string;
  email: string;
}

interface DeviceRow {
  id: string;
  account_id: string;
}

interface PairingTokenRow {
  token_hash: string;
  account_id: string;
  expires_at: string;
  used_at: string | null;
}

interface OnboardingTokenRow {
  token_hash: string;
  account_id: string;
  sso_session_id: string | null;
  expires_at: string;
  used_at: string | null;
  attempts: number;
}

interface ConversationRow {
  id: string;
  account_id: string;
  phone_number: string;
  verified_at: string | null;
}

interface SessionRow {
  id: string;
  device_id: string;
  account_id: string;
  cwd: string | null;
  agent: string;
  state: string;
  afk: string;
  grant: string;
  last_event_at: string;
}

interface AttentionRow {
  id: string;
  device_id: string;
  session_id: string;
  account_id: string;
  kind: string;
  tool_name: string | null;
  description: string | null;
  input_preview: string | null;
  request_id: string | null;
  qid: string | null;
  notify_message_id: string | null;
  created_at: string;
  resolved: boolean;
}

interface DecisionRow {
  id: string;
  attention_id: string;
  behavior: string | null;
  answer_text: string | null;
  grant: string | null;
  source: string;
  resolved_at: string;
}

interface MessageLogRow {
  direction: string;
  body: string;
  created_at: string;
}

// --- mappers ------------------------------------------------------------------

function toSessionInfo(r: SessionRow): SessionInfo {
  const info: SessionInfo = {
    id: r.id,
    deviceId: r.device_id,
    agent: r.agent as AgentKind,
    lastEventAt: new Date(r.last_event_at).toISOString(),
    state: r.state as SessionState,
    afk: r.afk as AfkState,
    grant: r.grant as GrantLevel,
  };
  if (r.cwd !== null) info.cwd = r.cwd;
  return info;
}

function toAttentionEvent(r: AttentionRow): AttentionEvent {
  const e: AttentionEvent = {
    id: r.id,
    deviceId: r.device_id,
    sessionId: r.session_id,
    kind: r.kind as AttentionKind,
    createdAt: new Date(r.created_at).toISOString(),
  };
  if (r.tool_name !== null) e.toolName = r.tool_name;
  if (r.description !== null) e.description = r.description;
  if (r.input_preview !== null) e.inputPreview = r.input_preview;
  if (r.request_id !== null) e.requestId = r.request_id;
  if (r.qid !== null) e.qid = r.qid;
  if (r.notify_message_id !== null) e.notifyMessageId = r.notify_message_id;
  return e;
}

function toDecision(r: DecisionRow): Decision {
  const d: Decision = {
    attentionId: r.attention_id,
    resolvedAt: new Date(r.resolved_at).toISOString(),
    source: r.source as DecisionSource,
  };
  if (r.behavior !== null) d.behavior = r.behavior as DecisionBehavior;
  if (r.answer_text !== null) d.answerText = r.answer_text;
  if (r.grant !== null) d.grant = r.grant as GrantLevel;
  return d;
}

// --- accounts / conversations -------------------------------------------------

/** Resolve an inbound phone number to a VERIFIED conversation's account. */
export async function findAccountByPhone(
  phoneNumber: string,
): Promise<{ accountId: string; conversationId: string } | undefined> {
  const row = await queryOne<ConversationRow>(
    `SELECT id, account_id, phone_number, verified_at
       FROM conversations
      WHERE phone_number = $1 AND verified_at IS NOT NULL`,
    [phoneNumber],
  );
  if (!row) return undefined;
  return { accountId: row.account_id, conversationId: row.id };
}

/** A verified phone number to send outbound messages back to, for an account. */
export async function findVerifiedPhoneForAccount(
  accountId: string,
): Promise<string | undefined> {
  const row = await queryOne<ConversationRow>(
    `SELECT phone_number
       FROM conversations
      WHERE account_id = $1 AND verified_at IS NOT NULL
      ORDER BY verified_at DESC
      LIMIT 1`,
    [accountId],
  );
  return row?.phone_number;
}

/**
 * Atomically consume a single-use onboarding token (by its peppered hash) and
 * link + VERIFY the sender's phone number to the token's account. This is what
 * completes onboarding: the user texts "hey! this is <token>" from their phone,
 * we bind that number to their account so all future inbound resolves via
 * findAccountByPhone, and the dashboard's status poll sees a verified
 * conversation. Returns the account/conversation, or undefined if the token is
 * unknown / expired / already used.
 */
export async function consumeOnboardingTokenAndLinkNumber(args: {
  onboardingTokenHash: string;
  phoneNumber: string;
}): Promise<{ accountId: string; conversationId: string } | undefined> {
  return withTransaction(async (client) => {
    // Lock the token row; only succeed if unused and unexpired (single-use).
    const tokenRes = await client.query<OnboardingTokenRow>(
      `SELECT token_hash, account_id, sso_session_id, expires_at, used_at, attempts
         FROM onboarding_tokens
        WHERE token_hash = $1
          AND used_at IS NULL
          AND expires_at > now()
        FOR UPDATE`,
      [args.onboardingTokenHash],
    );
    const token = tokenRes.rows[0];
    if (!token) return undefined;

    await client.query(
      `UPDATE onboarding_tokens
          SET used_at = now(), attempts = attempts + 1
        WHERE token_hash = $1`,
      [args.onboardingTokenHash],
    );

    // Bind + verify the sender's number to this account. phone_number is UNIQUE;
    // last onboarding wins if the number was previously linked elsewhere.
    const convRes = await client.query<ConversationRow>(
      `INSERT INTO conversations (account_id, phone_number, verified_at)
       VALUES ($1, $2, now())
       ON CONFLICT (phone_number)
       DO UPDATE SET account_id = EXCLUDED.account_id, verified_at = now()
       RETURNING id, account_id, phone_number, verified_at`,
      [token.account_id, args.phoneNumber],
    );
    const conv = convRes.rows[0];
    if (!conv) return undefined;
    return { accountId: conv.account_id, conversationId: conv.id };
  });
}

// --- pairing / devices --------------------------------------------------------

/**
 * Atomically consume a single-use pairing token (by its peppered hash) and
 * create a device bound to the token's account. Returns the new device id, or
 * undefined if the token is unknown/expired/already used.
 */
export async function consumePairingTokenAndCreateDevice(args: {
  pairingTokenHash: string;
  deviceTokenHash: string;
  os: string | undefined;
  hostname: string | undefined;
}): Promise<{ deviceId: string; accountId: string } | undefined> {
  return withTransaction(async (client) => {
    // Lock the token row; only succeed if unused and unexpired.
    const tokenRes = await client.query<PairingTokenRow>(
      `SELECT token_hash, account_id, expires_at, used_at
         FROM pairing_tokens
        WHERE token_hash = $1
          AND used_at IS NULL
          AND expires_at > now()
        FOR UPDATE`,
      [args.pairingTokenHash],
    );
    const token = tokenRes.rows[0];
    if (!token) return undefined;

    await client.query(
      `UPDATE pairing_tokens SET used_at = now() WHERE token_hash = $1`,
      [args.pairingTokenHash],
    );

    const devRes = await client.query<DeviceRow>(
      `INSERT INTO devices (account_id, device_token_hash, os, hostname)
       VALUES ($1, $2, $3, $4)
       RETURNING id, account_id`,
      [token.account_id, args.deviceTokenHash, args.os ?? null, args.hostname ?? null],
    );
    const device = devRes.rows[0];
    if (!device) return undefined;
    return { deviceId: device.id, accountId: device.account_id };
  });
}

/** Resolve an active (non-revoked) device by its peppered token hash. */
export async function findDeviceByTokenHash(
  deviceTokenHash: string,
): Promise<{ deviceId: string; accountId: string } | undefined> {
  const row = await queryOne<DeviceRow>(
    `SELECT id, account_id
       FROM devices
      WHERE device_token_hash = $1 AND revoked_at IS NULL`,
    [deviceTokenHash],
  );
  if (!row) return undefined;
  return { deviceId: row.id, accountId: row.account_id };
}

// --- sessions -----------------------------------------------------------------

/**
 * Upsert a session by id, scoped to the device + account. Used by the device
 * API so attention/heartbeat/state can reference a session that the device
 * names. Returns the resulting SessionInfo.
 */
export async function upsertSession(args: {
  sessionId: string;
  deviceId: string;
  accountId: string;
  cwd?: string | undefined;
  state?: SessionState | undefined;
}): Promise<SessionInfo> {
  const row = await queryOne<SessionRow>(
    `INSERT INTO sessions (id, device_id, account_id, cwd, agent, state, last_event_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'active'), now())
     ON CONFLICT (id) DO UPDATE
        SET -- Reassign to the current device, and scope the claim by ACCOUNT (not
            -- device). A re-pair on the same machine mints a NEW device_id under
            -- the same account; a long-running channel keeps its session id across
            -- that, so without this every heartbeat 500s ("belongs to a different
            -- device"). The session id is a 128-bit random UUID and the caller is
            -- an authenticated device of the account, so cross-account stays safe.
            device_id     = $2,
            cwd           = COALESCE(EXCLUDED.cwd, sessions.cwd),
            -- A heartbeat revives a session the staleness reaper had ended (e.g.
            -- the device slept past the window, then woke and beat again).
            state         = COALESCE($6, CASE WHEN sessions.state = 'ended'
                                              THEN 'active' ELSE sessions.state END),
            last_event_at = now()
      WHERE sessions.account_id = $3
     RETURNING *`,
    [
      args.sessionId,
      args.deviceId,
      args.accountId,
      args.cwd ?? null,
      AgentKind.CLAUDE_CODE,
      args.state ?? null,
    ],
  );
  if (!row) {
    throw new Error('upsertSession: session id belongs to a different account');
  }
  return toSessionInfo(row);
}

/** Touch last_event_at for a device's session (heartbeat). */
export async function touchSession(args: {
  sessionId: string;
  deviceId: string;
  accountId: string;
}): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE sessions SET last_event_at = now()
      WHERE id = $1 AND device_id = $2 AND account_id = $3
      RETURNING id`,
    [args.sessionId, args.deviceId, args.accountId],
  );
  return rows.length > 0;
}

/**
 * Staleness window for the session liveness reaper. The device heartbeats every
 * 60s (HEARTBEAT_INTERVAL_MS), so this is several missed beats — generous enough
 * not to false-reap a brief blip, and a live process that beats again is revived
 * by upsertSession. Tune down for snappier cleanup, up if you see false-deaths.
 */
export const SESSION_STALE_SECONDS = 300;

/**
 * Server-side liveness reaper: mark sessions `ended` once their last heartbeat
 * is older than the staleness window. This is the AUTHORITATIVE cleanup — the
 * device's client-side shutdown hooks can't cover SIGKILL / crash / laptop-sleep
 * / lost-network (and Claude Code's MCP-server lifecycle is unreliable), so the
 * control plane must not depend on a goodbye message. Both live-session reads
 * already filter `state <> 'ended'`, so reaping here hides dead sessions from the
 * dashboard + orchestrator. Idempotent — safe to run on every control-plane
 * instance. Returns the number of sessions reaped.
 */
export async function reapStaleSessions(
  staleSeconds: number = SESSION_STALE_SECONDS,
): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE sessions
        SET state = 'ended'
      WHERE state <> 'ended'
        AND last_event_at < now() - ($1::int * interval '1 second')
      RETURNING id`,
    [staleSeconds],
  );
  return rows.length;
}

/** Update afk/grant on a device's session. */
export async function updateSessionState(args: {
  sessionId: string;
  deviceId: string;
  accountId: string;
  afk?: AfkState | undefined;
  grant?: GrantLevel | undefined;
}): Promise<SessionInfo | undefined> {
  const row = await queryOne<SessionRow>(
    `UPDATE sessions
        SET afk           = COALESCE($4, afk),
            "grant"       = COALESCE($5, "grant"),
            last_event_at = now()
      WHERE id = $1 AND device_id = $2 AND account_id = $3
     RETURNING *`,
    [args.sessionId, args.deviceId, args.accountId, args.afk ?? null, args.grant ?? null],
  );
  return row ? toSessionInfo(row) : undefined;
}

/**
 * Apply afk/grant across ALL of a device's LIVE (non-ended) sessions. Used by
 * the device-wide `imsg afk/grant` path (POST /api/device/state with no
 * sessionId): the CLI toggles AFK/grant for the whole machine, not one session.
 * Returns the updated SessionInfo rows (most-recent-first). FULL is reachable
 * here only via the authenticated device/dashboard path, never via the LLM.
 */
export async function updateSessionStateForDevice(args: {
  deviceId: string;
  accountId: string;
  afk?: AfkState | undefined;
  grant?: GrantLevel | undefined;
}): Promise<SessionInfo[]> {
  const rows = await query<SessionRow>(
    `UPDATE sessions
        SET afk           = COALESCE($3, afk),
            "grant"       = COALESCE($4, "grant"),
            last_event_at = now()
      WHERE device_id = $1 AND account_id = $2 AND state <> $5
     RETURNING *`,
    [
      args.deviceId,
      args.accountId,
      args.afk ?? null,
      args.grant ?? null,
      SessionState.ENDED,
    ],
  );
  // Order most-recent-first to mirror listLiveSessionsForAccount.
  return rows
    .map(toSessionInfo)
    .sort((a, b) => (a.lastEventAt < b.lastEventAt ? 1 : -1));
}

/**
 * Current device state for the GET /api/device/state killswitch + state probe.
 * Reports `enabled` from the device row (revoked_at IS NULL AND disabled_at IS
 * NULL) and the afk/grant of the device's MOST-RECENT live session (the CLI's
 * device-wide toggles keep these uniform across the device's sessions). When
 * the device has no live session, afk/grant default to off.
 */
export async function getDeviceState(args: {
  deviceId: string;
  accountId: string;
}): Promise<{ enabled: boolean; afk: AfkState; grant: GrantLevel }> {
  const dev = await queryOne<{ enabled: boolean }>(
    `SELECT (revoked_at IS NULL AND disabled_at IS NULL) AS enabled
       FROM devices
      WHERE id = $1 AND account_id = $2`,
    [args.deviceId, args.accountId],
  );
  const enabled = dev?.enabled ?? false;

  const sess = await queryOne<SessionRow>(
    `SELECT * FROM sessions
      WHERE device_id = $1 AND account_id = $2 AND state <> $3
      ORDER BY last_event_at DESC
      LIMIT 1`,
    [args.deviceId, args.accountId, SessionState.ENDED],
  );
  const afk = (sess?.afk as AfkState | undefined) ?? AfkState.OFF;
  const grant = (sess?.grant as GrantLevel | undefined) ?? GrantLevel.OFF;
  return { enabled, afk, grant };
}

/** Get a single session scoped to a device + account. */
export async function getSessionForDevice(args: {
  sessionId: string;
  deviceId: string;
  accountId: string;
}): Promise<SessionInfo | undefined> {
  const row = await queryOne<SessionRow>(
    `SELECT * FROM sessions WHERE id = $1 AND device_id = $2 AND account_id = $3`,
    [args.sessionId, args.deviceId, args.accountId],
  );
  return row ? toSessionInfo(row) : undefined;
}

/** All non-ended sessions for an account (orchestrator + dashboard view). */
export async function listLiveSessionsForAccount(
  accountId: string,
): Promise<SessionInfo[]> {
  const rows = await query<SessionRow>(
    `SELECT * FROM sessions
      WHERE account_id = $1 AND state <> $2
      ORDER BY last_event_at DESC`,
    [accountId, SessionState.ENDED],
  );
  return rows.map(toSessionInfo);
}

// --- attention events ---------------------------------------------------------

/** Insert a device-reported attention event (account/device/session scoped). */
export async function insertAttentionEvent(args: {
  deviceId: string;
  accountId: string;
  event: AttentionEvent;
}): Promise<AttentionEvent> {
  const e = args.event;
  const row = await queryOne<AttentionRow>(
    `INSERT INTO attention_events
       (device_id, session_id, account_id, kind, tool_name, description,
        input_preview, request_id, qid)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
      WHERE EXISTS (
        SELECT 1 FROM sessions s
         WHERE s.id = $2 AND s.device_id = $1 AND s.account_id = $3
      )
     RETURNING *`,
    [
      args.deviceId,
      e.sessionId,
      args.accountId,
      e.kind,
      e.toolName ?? null,
      e.description ?? null,
      e.inputPreview ?? null,
      e.requestId ?? null,
      e.qid ?? null,
    ],
  );
  if (!row) {
    throw new Error('insertAttentionEvent: session not owned by this device/account');
  }
  return toAttentionEvent(row);
}

/** All UNRESOLVED attention events for an account (orchestrator targeting). */
export async function listPendingAttentionForAccount(
  accountId: string,
): Promise<AttentionEvent[]> {
  const rows = await query<AttentionRow>(
    `SELECT * FROM attention_events
      WHERE account_id = $1 AND resolved = false
      ORDER BY created_at ASC`,
    [accountId],
  );
  return rows.map(toAttentionEvent);
}

/** Load a single attention event scoped to an account. */
export async function getAttentionForAccount(args: {
  attentionId: string;
  accountId: string;
}): Promise<AttentionEvent | undefined> {
  const row = await queryOne<AttentionRow>(
    `SELECT * FROM attention_events WHERE id = $1 AND account_id = $2`,
    [args.attentionId, args.accountId],
  );
  return row ? toAttentionEvent(row) : undefined;
}

/**
 * Persist the provider message id of the OUTBOUND phone notification that
 * fronted this attention. This is the canonical deterministic binding target:
 * a tapback/inline reply carrying this id binds to THIS attention (see
 * orchestrator/safety.ts deterministicTarget). Scoped to account. Returns true
 * if a row was updated.
 */
export async function setAttentionNotifyMessageId(
  attentionId: string,
  messageId: string,
  accountId: string,
): Promise<boolean> {
  // Account-scoped: the assistant's send_message tool passes an LLM-provided
  // attentionId, so the write MUST be constrained to the caller's account — a
  // hallucinated/foreign id matches 0 rows rather than touching another tenant.
  const rows = await query<{ id: string }>(
    `UPDATE attention_events
        SET notify_message_id = $2
      WHERE id = $1 AND account_id = $3
      RETURNING id`,
    [attentionId, messageId, accountId],
  );
  return rows.length > 0;
}

// --- decisions ----------------------------------------------------------------

/**
 * Resolve an attention event by inserting a Decision and flipping `resolved`.
 * The decisions INSERT fires the LISTEN/NOTIFY trigger that wakes the device
 * long-poll. Scoped to account; the attention must be unresolved.
 *
 * Returns the persisted Decision, or undefined if the attention was already
 * resolved / not found (idempotent — never double-resolves).
 */
export async function resolveAttention(args: {
  accountId: string;
  attentionId: string;
  behavior?: DecisionBehavior | undefined;
  answerText?: string | undefined;
  grant?: GrantLevel | undefined;
  source: DecisionSource;
}): Promise<Decision | undefined> {
  return withTransaction(async (client) => {
    // Claim the attention row (only if still unresolved + in this account).
    const claim = await client.query<{ id: string }>(
      `UPDATE attention_events
          SET resolved = true
        WHERE id = $1 AND account_id = $2 AND resolved = false
        RETURNING id`,
      [args.attentionId, args.accountId],
    );
    if (claim.rows.length === 0) return undefined;

    const optionalGrant = args.grant ?? null;
    const decRes = await client.query<DecisionRow>(
      `INSERT INTO decisions (attention_id, behavior, answer_text, "grant", source)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        args.attentionId,
        args.behavior ?? null,
        args.answerText ?? null,
        optionalGrant,
        args.source,
      ],
    );

    // If the decision carries a session-grant escalation, apply it to the
    // session so subsequent in-grant tools auto-proceed (mirrors the hook).
    if (optionalGrant !== null) {
      await client.query(
        `UPDATE sessions s
            SET "grant" = $1, last_event_at = now()
           FROM attention_events ae
          WHERE ae.id = $2 AND ae.session_id = s.id AND s.account_id = $3`,
        [optionalGrant, args.attentionId, args.accountId],
      );
    }

    const row = decRes.rows[0];
    if (!row) throw new Error('resolveAttention: decision insert returned no row');
    return toDecision(row);
  });
}

/**
 * Resolved decisions for a device's session, plus the data the device needs to
 * relay a permission verdict back to Claude Code.
 *
 * The device's channel server matches a permission Decision back to the open
 * Claude Code prompt by its Channels `request_id`. That id lives on the
 * originating attention_events row (request_id), so we return it as a
 * `requestIds[attentionId] -> request_id` map. We also return a `since` cursor
 * (the max resolved_at returned) so the device advances its poll cursor and
 * never re-applies (re-relays) a verdict/answer it already handled.
 */
export interface SessionDecisions {
  decisions: Decision[];
  /** attentionId -> Channels request_id (only for permission attentions). */
  requestIds: Record<string, string>;
  /** Max resolved_at across the returned decisions (ISO-8601), if any. */
  since: string | undefined;
}

/**
 * Fetch resolved decisions for a device's session created after `since`
 * (ISO-8601). Scoped so a device can only read decisions for its own sessions.
 */
export async function listDecisionsForSession(args: {
  sessionId: string;
  deviceId: string;
  accountId: string;
  since: string | undefined;
}): Promise<SessionDecisions> {
  const rows = await query<DecisionRow & { request_id: string | null }>(
    `SELECT d.*, ae.request_id AS request_id
       FROM decisions d
       JOIN attention_events ae ON ae.id = d.attention_id
       JOIN sessions s          ON s.id  = ae.session_id
      WHERE ae.session_id = $1
        AND s.device_id   = $2
        AND s.account_id  = $3
        AND ($4::timestamptz IS NULL OR d.resolved_at > $4::timestamptz)
      ORDER BY d.resolved_at ASC`,
    [args.sessionId, args.deviceId, args.accountId, args.since ?? null],
  );

  const decisions = rows.map(toDecision);
  const requestIds: Record<string, string> = {};
  let since: string | undefined;
  for (const r of rows) {
    if (r.request_id !== null) requestIds[r.attention_id] = r.request_id;
    const iso = new Date(r.resolved_at).toISOString();
    if (since === undefined || iso > since) since = iso;
  }
  return { decisions, requestIds, since };
}

// --- message log --------------------------------------------------------------

/** Append an inbound/outbound message to the durable log (account-scoped). */
export async function logMessage(args: {
  accountId: string;
  direction: 'inbound' | 'outbound';
  body: string;
}): Promise<void> {
  await query(
    `INSERT INTO message_log (account_id, direction, body) VALUES ($1, $2, $3)`,
    [args.accountId, args.direction, args.body],
  );
}

/** Recent thread history (most-recent-first) for orchestrator context. */
export async function recentMessages(args: {
  accountId: string;
  limit: number;
}): Promise<Array<{ direction: 'inbound' | 'outbound'; body: string; createdAt: string }>> {
  const rows = await query<MessageLogRow>(
    `SELECT direction, body, created_at
       FROM message_log
      WHERE account_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [args.accountId, args.limit],
  );
  return rows.map((r) => ({
    direction: r.direction as 'inbound' | 'outbound',
    body: r.body,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

// --- webhook idempotency ------------------------------------------------------

/**
 * Claim an inbound webhook delivery by its X-Webhook-ID. Returns true if THIS
 * call won the claim (the first time we've seen this id) and the caller should
 * process the message; false if the id was already claimed (a provider retry of
 * the same message) and the caller must skip. This is the dedup that stops an
 * at-least-once redelivery from re-running the assistant turn and texting the
 * user the same reply again. Atomic via INSERT ... ON CONFLICT DO NOTHING, so
 * two concurrent deliveries of the same id can never both win.
 */
export async function claimWebhook(webhookId: string): Promise<boolean> {
  const rows = await query<{ webhook_id: string }>(
    `INSERT INTO processed_webhooks (webhook_id) VALUES ($1)
       ON CONFLICT (webhook_id) DO NOTHING
     RETURNING webhook_id`,
    [webhookId],
  );
  return rows.length > 0;
}

/**
 * Release a previously-claimed webhook id so a provider redelivery can re-run.
 * The claim is TENTATIVE: we claim before processing (to dedup concurrent/fast
 * retries) but the row only legitimately means "handled" once the turn settles.
 * If the turn THROWS before doing its work (a transient DB/account-resolution
 * blip), releasing the claim restores the provider's at-least-once retry as the
 * recovery path — without this, a claimed-but-unanswered message would be
 * silently dropped, since we've already 200'd and the redelivery would dedup.
 */
export async function releaseWebhook(webhookId: string): Promise<void> {
  await query(`DELETE FROM processed_webhooks WHERE webhook_id = $1`, [webhookId]);
}

// --- session messages (free-text steering INTO a running session) -------------

/** A free-text steer queued for delivery into a session. */
export interface SessionMessage {
  id: string;
  body: string;
}

interface SessionMessageRow {
  id: string;
  body: string;
}

/**
 * Queue a free-text steer for a session. Tenant-scoped: the row is inserted ONLY
 * if the session exists, belongs to `accountId`, and is not ended — so a model
 * can never steer another account's (or a dead) session. Fires NOTIFY
 * 'session_message' to wake the device's event stream. Returns the new id, or
 * undefined if no matching live session.
 */
export async function insertSessionMessage(args: {
  sessionId: string;
  accountId: string;
  body: string;
}): Promise<{ id: string } | undefined> {
  const rows = await query<{ id: string }>(
    `INSERT INTO session_messages (session_id, account_id, body)
       SELECT s.id, s.account_id, $3
         FROM sessions s
        WHERE s.id = $1 AND s.account_id = $2 AND s.state <> 'ended'
     RETURNING id`,
    [args.sessionId, args.accountId, args.body],
  );
  return rows[0];
}

/**
 * Undelivered steers for a device's session (oldest first). Scoped so a device
 * can only drain its own session's messages.
 */
export async function listUndeliveredSessionMessages(args: {
  sessionId: string;
  deviceId: string;
  accountId: string;
}): Promise<SessionMessage[]> {
  const rows = await query<SessionMessageRow>(
    `SELECT sm.id, sm.body
       FROM session_messages sm
       JOIN sessions s ON s.id = sm.session_id
      WHERE sm.session_id = $1
        AND s.device_id   = $2
        AND s.account_id  = $3
        AND sm.delivered_at IS NULL
      ORDER BY sm.created_at ASC`,
    [args.sessionId, args.deviceId, args.accountId],
  );
  return rows.map((r) => ({ id: r.id, body: r.body }));
}

/** Mark steers delivered (after the device has injected them into the session). */
export async function markSessionMessagesDelivered(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await query(`UPDATE session_messages SET delivered_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
}

export type { AccountRow };
