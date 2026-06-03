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
  ATTENTION_TEXT_MAX_LEN,
  AfkState,
  AgentKind,
  AttentionKind,
  DecisionBehavior,
  SessionState,
  isAfkState,
  isAgentKind,
  type ActivityEvent,
  type ActivityKind,
  type AttentionEvent,
  type DeviceInfo,
  type InboxItem,
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

/** Device + machine-wide afk + live-session count (DeviceInfo backing). */
interface DeviceStateRow {
  id: string;
  os: string | null;
  hostname: string | null;
  afk: string;
  enabled: boolean;
  session_count: string | number;
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
  title: string | null;
  agent: string;
  state: string;
  afk: string;
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

interface InboxRow {
  id: string;
  kind: string;
  text: string | null;
  request_id: string | null;
  behavior: string | null;
  attention_id: string | null;
}

interface MessageLogRow {
  direction: string;
  body: string;
  created_at: string;
}

// --- mappers ------------------------------------------------------------------

// afk is MACHINE-WIDE (it lives on `devices`, not `sessions`), so every session
// read sources it from its device via this JOIN. Selecting explicit columns (not
// `s.*, d.afk`) avoids the afk name collision between the two tables.
// SessionInfo.afk therefore always reflects the device's value.
const SESSION_FROM = 'FROM sessions s JOIN devices d ON d.id = s.device_id';
const SESSION_COLUMNS =
  's.id, s.device_id, s.account_id, s.cwd, s.title, s.agent, s.state, ' +
  's.last_event_at, d.afk';

function toSessionInfo(r: SessionRow): SessionInfo {
  const info: SessionInfo = {
    id: r.id,
    deviceId: r.device_id,
    agent: r.agent as AgentKind,
    lastEventAt: new Date(r.last_event_at).toISOString(),
    state: r.state as SessionState,
    afk: r.afk as AfkState,
  };
  if (r.cwd !== null) info.cwd = r.cwd;
  if (r.title !== null) info.title = r.title;
  return info;
}

function toDeviceInfo(r: DeviceStateRow): DeviceInfo {
  // Friendly label: hostname, else os, else the short id (mirrors the session
  // card's title→folder fallback).
  const label = r.hostname?.trim() || r.os?.trim() || r.id.slice(0, 8);
  const info: DeviceInfo = {
    id: r.id,
    label,
    afk: r.afk as AfkState,
    enabled: r.enabled,
    sessionCount: Number(r.session_count),
  };
  // Truthy guard (not !== null) so an empty string is omitted, matching the
  // dashboard's lib/devices.ts mapper — the two must agree on the wire shape.
  if (r.os) info.os = r.os;
  if (r.hostname) info.hostname = r.hostname;
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

function toInboxItem(r: InboxRow): InboxItem {
  const item: InboxItem = { id: r.id, kind: r.kind as InboxItem['kind'] };
  if (r.text !== null) item.text = r.text;
  if (r.request_id !== null) item.requestId = r.request_id;
  if (r.behavior !== null) item.behavior = r.behavior as DecisionBehavior;
  if (r.attention_id !== null) item.attentionId = r.attention_id;
  return item;
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
 * conversation. Returns { ok: true, ... } on success, or { ok: false, reason }
 * naming WHY it failed (invalid / expired / used) so the caller can text the
 * sender a specific message instead of staying silent.
 */
export type OnboardingLinkFailure = 'invalid' | 'expired' | 'used';

export type OnboardingLinkResult =
  | { ok: true; accountId: string; conversationId: string }
  | { ok: false; reason: OnboardingLinkFailure };

export async function consumeOnboardingTokenAndLinkNumber(args: {
  onboardingTokenHash: string;
  phoneNumber: string;
}): Promise<OnboardingLinkResult> {
  return withTransaction(async (client) => {
    // Lock the token row by hash WITHOUT the validity filter so we can tell the
    // user WHY it failed (vs. one silent miss). Single-use stays atomic: we only
    // consume + link in the valid branch below, still under this FOR UPDATE lock.
    const tokenRes = await client.query<OnboardingTokenRow & { is_expired: boolean }>(
      `SELECT token_hash, account_id, sso_session_id, expires_at, used_at, attempts,
              (expires_at <= now()) AS is_expired
         FROM onboarding_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [args.onboardingTokenHash],
    );
    const token = tokenRes.rows[0];
    if (!token) return { ok: false, reason: 'invalid' };
    if (token.used_at) return { ok: false, reason: 'used' };
    if (token.is_expired) return { ok: false, reason: 'expired' };

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
    if (!conv) return { ok: false, reason: 'invalid' };
    return { ok: true, accountId: conv.account_id, conversationId: conv.id };
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
 *
 * `reviveIfEnded` (default true): on conflict, flip a reaper-`ended` session back
 * to `active`. The heartbeat path wants this (a slept device that beats again is
 * alive). The activity tap does NOT — a late transcript tail-flush from a dying
 * session is not proof of life; reviving on it would re-arm the staleness reaper
 * (double-firing the "session stopped" notice) and resurrect a dashboard ghost.
 * An explicit `state` always wins over both (COALESCE on $6).
 */
export async function upsertSession(args: {
  sessionId: string;
  deviceId: string;
  accountId: string;
  cwd?: string | undefined;
  title?: string | undefined;
  state?: SessionState | undefined;
  reviveIfEnded?: boolean | undefined;
  /** Which coding agent the device reports for this session. Old plugins don't
   *  send it (and a forged value is untrusted), so an absent/invalid value
   *  defaults to AgentKind.CLAUDE_CODE — the prior hardcoded behavior. */
  agent?: AgentKind | undefined;
}): Promise<SessionInfo> {
  const agent = isAgentKind(args.agent) ? args.agent : AgentKind.CLAUDE_CODE;
  const row = await queryOne<SessionRow>(
    `INSERT INTO sessions (id, device_id, account_id, cwd, title, agent, state, last_event_at)
     VALUES ($1, $2, $3, $4, $7, $5, COALESCE($6, 'active'), now())
     ON CONFLICT (id) DO UPDATE
        SET -- Reassign to the current device, and scope the claim by ACCOUNT (not
            -- device). A re-pair on the same machine mints a NEW device_id under
            -- the same account; a long-running channel keeps its session id across
            -- that, so without this every heartbeat 500s ("belongs to a different
            -- device"). The session id is a 128-bit random UUID and the caller is
            -- an authenticated device of the account, so cross-account stays safe.
            device_id     = $2,
            cwd           = COALESCE(EXCLUDED.cwd, sessions.cwd),
            -- Title takes the newest non-null value (last-writer-wins): the device
            -- starts with a provisional first-message label and UPGRADES it to
            -- Claude Code's own ai-title / a /rename custom-title once the tap sees
            -- one. A missing title ($7 NULL) never clobbers, and re-sending the same
            -- final title is idempotent, so this converges and stays put.
            title         = COALESCE(EXCLUDED.title, sessions.title),
            -- A heartbeat revives a session the staleness reaper had ended (e.g.
            -- the device slept past the window, then woke and beat again) — but
            -- only when $8 (reviveIfEnded). The activity tap passes false so a
            -- late tail-flush can't resurrect a dead session.
            state         = COALESCE($6, CASE WHEN sessions.state = 'ended' AND $8
                                              THEN 'active' ELSE sessions.state END),
            last_event_at = now()
      WHERE sessions.account_id = $3
     RETURNING *`,
    [
      args.sessionId,
      args.deviceId,
      args.accountId,
      args.cwd ?? null,
      agent,
      args.state ?? null,
      args.title ?? null,
      args.reviveIfEnded ?? true,
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
 * 10s (HEARTBEAT_INTERVAL_MS), so this is three missed beats — tight enough to
 * drop dead sessions within ~30-40s, generous enough not to false-reap a brief
 * blip (a live process that beats again is revived by upsertSession). Tune down
 * for snappier cleanup, up if you see false-deaths.
 */
export const SESSION_STALE_SECONDS = 30;

/** A session the reaper just transitioned to `ended`, carrying enough to notify
 *  the user it stopped: its account, human title, and its device's machine-wide
 *  afk (joined from `devices` — afk gates whether we surface it to the phone). */
export interface ReapedSession {
  id: string;
  accountId: string;
  title: string | null;
  afk: AfkState;
}

/**
 * Server-side liveness reaper: mark sessions `ended` once their last heartbeat
 * is older than the staleness window. This is the AUTHORITATIVE cleanup — the
 * device's client-side shutdown hooks can't cover SIGKILL / crash / laptop-sleep
 * / lost-network (and Claude Code's MCP-server lifecycle is unreliable), so the
 * control plane must not depend on a goodbye message. Both live-session reads
 * already filter `state <> 'ended'`, so reaping here hides dead sessions from the
 * dashboard + orchestrator. Idempotent — safe to run on every control-plane
 * instance.
 *
 * Returns the sessions THIS call transitioned (joined to their device's afk +
 * title). The `state <> 'ended'` guard + `RETURNING` make that set exactly-once
 * across instances — only the instance whose UPDATE wins the row sees it — so a
 * multi-machine deploy notifies the user about a stopped session exactly once.
 */
export async function reapStaleSessions(
  staleSeconds: number = SESSION_STALE_SECONDS,
): Promise<ReapedSession[]> {
  const rows = await query<{
    id: string;
    account_id: string;
    title: string | null;
    afk: string;
  }>(
    `UPDATE sessions s
        SET state = 'ended'
       FROM devices d
      WHERE s.device_id = d.id
        AND s.state <> 'ended'
        AND s.last_event_at < now() - ($1::int * interval '1 second')
      RETURNING s.id, s.account_id, s.title, d.afk`,
    [staleSeconds],
  );
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    title: r.title,
    // Fail closed: an unexpected afk value reads as OFF (no notification) rather
    // than a lying cast that could slip a junk string into the afk='on' filter.
    afk: isAfkState(r.afk) ? r.afk : AfkState.OFF,
  }));
}

// afk is MACHINE-WIDE and lives on `devices`. These RETURNING columns +
// the live-session count back the DeviceInfo wire shape. The count is a
// correlated subquery so a single UPDATE ... RETURNING yields a full DeviceInfo.
const DEVICE_COLUMNS =
  'd.id, d.os, d.hostname, d.afk, ' +
  '(d.revoked_at IS NULL AND d.disabled_at IS NULL) AS enabled, ' +
  "(SELECT count(*) FROM sessions s WHERE s.device_id = d.id AND s.state <> 'ended') " +
  'AS session_count';

/** Set a device's machine-wide AFK (the dashboard/CLI toggle). Returns the
 *  updated device, or undefined if it isn't this account's device. No session
 *  write → the staleness reaper's clock is never bumped by a remote toggle. */
export async function setDeviceAfk(args: {
  deviceId: string;
  accountId: string;
  afk: AfkState;
}): Promise<DeviceInfo | undefined> {
  const row = await queryOne<DeviceStateRow>(
    `UPDATE devices d SET afk = $1
      WHERE d.id = $2 AND d.account_id = $3
     RETURNING ${DEVICE_COLUMNS}`,
    [args.afk, args.deviceId, args.accountId],
  );
  return row ? toDeviceInfo(row) : undefined;
}

/**
 * Set AFK on the DEVICES behind a named set of the account's LIVE sessions. Used
 * by the orchestrator's `set_afk` tool (the phone steering AFK on/off): the model
 * names sessions, but AFK is machine-wide, so we flip each named session's whole
 * device. account_id is the tenant boundary; ids that aren't a live session of
 * this account are silently skipped. Returns the matched session ids so the
 * caller can report what took effect. Each device's live streams pick the change
 * up via the `device_state` notify → SSE `state` flush.
 *
 * AFK only moves WHERE prompts surface; it carries no auto-approve power, so it
 * is safe for the LLM to flip.
 */
export async function setDevicesAfkForSessions(args: {
  accountId: string;
  sessionIds: string[];
  afk: AfkState;
}): Promise<string[]> {
  if (args.sessionIds.length === 0) return [];
  // The `upd` data-modifying CTE always executes (Postgres runs every
  // data-modifying WITH term); the final SELECT returns the matched session ids.
  const rows = await query<{ id: string }>(
    `WITH matched AS (
        SELECT id, device_id FROM sessions
         WHERE account_id = $2 AND id = ANY($3::uuid[]) AND state <> $4
      ), upd AS (
        UPDATE devices d SET afk = $1
          FROM (SELECT DISTINCT device_id FROM matched) m
         WHERE d.id = m.device_id AND d.account_id = $2
         RETURNING d.id
      )
      SELECT id FROM matched`,
    [args.afk, args.accountId, args.sessionIds, SessionState.ENDED],
  );
  return rows.map((r) => r.id);
}

/** The account's ACTIVE devices (non-revoked + at least one live session), each
 *  with its machine-wide afk + live-session count. Most-recently-active
 *  first. The live-session filter both keeps the list to machines worth toggling
 *  and collapses stale re-pair duplicates (which carry no live sessions). */
export async function listDevicesForAccount(
  accountId: string,
): Promise<DeviceInfo[]> {
  const rows = await query<DeviceStateRow>(
    `SELECT ${DEVICE_COLUMNS}
       FROM devices d
      WHERE d.account_id = $1 AND d.revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.state <> 'ended'
        )
      ORDER BY (
        SELECT max(last_event_at) FROM sessions s WHERE s.device_id = d.id
      ) DESC NULLS LAST, d.paired_at DESC`,
    [accountId],
  );
  return rows.map(toDeviceInfo);
}

/**
 * Current device state for the GET /api/device/state killswitch + state probe.
 * `enabled` = revoked_at IS NULL AND disabled_at IS NULL; afk is the device's own
 * machine-wide column (the single source of truth). A missing device row reports
 * disabled + off (fail-closed).
 */
export async function getDeviceState(args: {
  deviceId: string;
  accountId: string;
}): Promise<{ enabled: boolean; afk: AfkState }> {
  const dev = await queryOne<{ enabled: boolean; afk: string }>(
    `SELECT (revoked_at IS NULL AND disabled_at IS NULL) AS enabled, afk
       FROM devices
      WHERE id = $1 AND account_id = $2`,
    [args.deviceId, args.accountId],
  );
  return {
    enabled: dev?.enabled ?? false,
    afk: (dev?.afk as AfkState | undefined) ?? AfkState.OFF,
  };
}

/** Get a single session scoped to a device + account. */
export async function getSessionForDevice(args: {
  sessionId: string;
  deviceId: string;
  accountId: string;
}): Promise<SessionInfo | undefined> {
  const row = await queryOne<SessionRow>(
    `SELECT ${SESSION_COLUMNS} ${SESSION_FROM}
      WHERE s.id = $1 AND s.device_id = $2 AND s.account_id = $3`,
    [args.sessionId, args.deviceId, args.accountId],
  );
  return row ? toSessionInfo(row) : undefined;
}

/** All non-ended sessions for an account (orchestrator + dashboard view). */
export async function listLiveSessionsForAccount(
  accountId: string,
): Promise<SessionInfo[]> {
  const rows = await query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} ${SESSION_FROM}
      WHERE s.account_id = $1 AND s.state <> $2
      ORDER BY s.last_event_at DESC`,
    [accountId, SessionState.ENDED],
  );
  return rows.map(toSessionInfo);
}

// --- session activity (the realtime transcript tap) ---------------------------

interface SessionActivityRow {
  line_no: number;
  block_idx: number;
  kind: string;
  tool_name: string | null;
  summary: string | null;
  body: string | null;
  is_error: boolean;
  created_at: string;
}

/** A surfaced unit of session activity for orchestrator context (most-recent-first). */
export interface SessionActivity {
  kind: ActivityKind;
  toolName?: string;
  summary?: string;
  body?: string;
  isError: boolean;
  createdAt: string;
}

function toSessionActivity(r: SessionActivityRow): SessionActivity {
  const a: SessionActivity = {
    kind: r.kind as ActivityKind,
    isError: r.is_error,
    createdAt: new Date(r.created_at).toISOString(),
  };
  if (r.tool_name !== null) a.toolName = r.tool_name;
  if (r.summary !== null) a.summary = r.summary;
  if (r.body !== null) a.body = r.body;
  return a;
}

/**
 * Bulk-insert a batch of session-activity events (the realtime tap). Tenant-scoped:
 * rows are inserted ONLY if the session belongs to this device + account (the
 * WHERE EXISTS guard, like insertAttentionEvent), so a device can never write
 * activity into another tenant's session. Idempotent via ON CONFLICT on the
 * transcript position (session_id, line_no, block_idx) — a device re-read after a
 * crash (before its byte cursor committed) is de-duped, not double-inserted.
 * Returns the number of rows actually inserted.
 */
export async function insertSessionActivity(args: {
  deviceId: string;
  accountId: string;
  sessionId: string;
  events: ReadonlyArray<ActivityEvent>;
}): Promise<number> {
  if (args.events.length === 0) return 0;
  // Server-side length clamp: the device sanitizer caps these, but a forged/buggy
  // device must not be able to bloat the table. Defense-in-depth, not the primary guard.
  const BODY_CAP = 4_000;
  const NAME_CAP = 200;
  const clamp = (s: string | undefined, n: number): string | null =>
    s === undefined ? null : s.length > n ? s.slice(0, n) : s;
  const lineNos = args.events.map((e) => e.lineNo);
  const blockIdxs = args.events.map((e) => e.blockIdx);
  const kinds = args.events.map((e) => e.kind);
  const toolNames = args.events.map((e) => clamp(e.toolName, NAME_CAP));
  const summaries = args.events.map((e) => clamp(e.summary, BODY_CAP));
  const bodies = args.events.map((e) => clamp(e.text, BODY_CAP));
  const isErrors = args.events.map((e) => e.isError ?? false);

  const rows = await query<{ id: string }>(
    `INSERT INTO session_activity
       (session_id, account_id, device_id, line_no, block_idx, kind, tool_name, summary, body, is_error)
     SELECT $1, $2, $3, t.line_no, t.block_idx, t.kind, t.tool_name, t.summary, t.body, t.is_error
       FROM unnest($4::int[], $5::int[], $6::text[], $7::text[], $8::text[], $9::text[], $10::bool[])
         AS t(line_no, block_idx, kind, tool_name, summary, body, is_error)
      WHERE EXISTS (
        SELECT 1 FROM sessions s
         WHERE s.id = $1 AND s.device_id = $3 AND s.account_id = $2
      )
     ON CONFLICT (session_id, line_no, block_idx) DO NOTHING
     RETURNING id`,
    [
      args.sessionId,
      args.accountId,
      args.deviceId,
      lineNos,
      blockIdxs,
      kinds,
      toolNames,
      summaries,
      bodies,
      isErrors,
    ],
  );
  return rows.length;
}

/** A session-activity row carrying its transcript position (for get_session_data). */
export interface SessionActivityLine extends SessionActivity {
  lineNo: number;
  blockIdx: number;
}

/** Hard cap on rows a single get_session_data read can return (prompt-size guard). */
const SESSION_DATA_MAX_ROWS = 200;

/**
 * Query a session's activity log for the `get_session_data` orchestrator tool.
 * Tenant-scoped. Three modes, composable:
 *   - default: the most-recent `limit` events (default 20), returned OLDEST-first.
 *   - grep:    case-insensitive substring over body / tool summary / tool name.
 *   - range:   only events whose monotonic line_no is within [fromLine, toLine].
 * Always returns OLDEST-first (ascending line_no) for readable display, and
 * carries each event's lineNo so the model can cite / re-slice a range.
 */
export async function getSessionActivity(args: {
  sessionId: string;
  accountId: string;
  limit?: number;
  grep?: string;
  fromLine?: number;
  toLine?: number;
}): Promise<SessionActivityLine[]> {
  // Normalize the LLM-supplied numbers up front: a junk value (NaN/Infinity/float)
  // must never reach a `LIMIT`/`line_no` clause and error the query.
  const intOrUndef = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined;
  const fromLine = intOrUndef(args.fromLine);
  const toLine = intOrUndef(args.toLine);
  const grep = args.grep && args.grep.trim() ? args.grep.trim() : undefined;

  const params: unknown[] = [args.sessionId, args.accountId];
  const where: string[] = ['session_id = $1', 'account_id = $2'];

  if (grep) {
    params.push(`%${grep}%`);
    const p = `$${params.length}`;
    where.push(`(body ILIKE ${p} OR summary ILIKE ${p} OR tool_name ILIKE ${p})`);
  }
  const hasRange = fromLine !== undefined || toLine !== undefined;
  if (fromLine !== undefined) {
    params.push(fromLine);
    where.push(`line_no >= $${params.length}`);
  }
  if (toLine !== undefined) {
    params.push(toLine);
    where.push(`line_no <= $${params.length}`);
  }

  // A line range reads a specific slice ascending; otherwise take the most-recent
  // `limit` (descending) and reverse to oldest-first below. Either way, cap rows.
  const wantLimit = intOrUndef(args.limit) ?? 20;
  const limit = hasRange
    ? SESSION_DATA_MAX_ROWS
    : Math.min(Math.max(1, wantLimit), SESSION_DATA_MAX_ROWS);
  params.push(limit);
  const order = hasRange ? 'ASC' : 'DESC';

  const rows = await query<SessionActivityRow>(
    `SELECT line_no, block_idx, kind, tool_name, summary, body, is_error, created_at
       FROM session_activity
      WHERE ${where.join(' AND ')}
      ORDER BY line_no ${order}, block_idx ${order}
      LIMIT $${params.length}`,
    params,
  );

  // Non-range mode fetched newest-first to honor `limit`; flip to oldest-first.
  const ordered = hasRange ? rows : [...rows].reverse();
  return ordered.map((r) => ({
    ...toSessionActivity(r),
    lineNo: r.line_no,
    blockIdx: r.block_idx,
  }));
}

// --- attention events ---------------------------------------------------------

/** Insert a device-reported attention event (account/device/session scoped). */
export async function insertAttentionEvent(args: {
  deviceId: string;
  accountId: string;
  event: AttentionEvent;
}): Promise<AttentionEvent> {
  const e = args.event;
  // Re-clamp the device-supplied text at the single write path: the device caps
  // these at egress (sanitizeText, 2000), but a forged/buggy client must not store
  // an oversized body that the orchestrator later renders in full. Enforcing it
  // here (not just at the route) covers every caller — routes, scripts, tests.
  const clampText = (s: string | undefined): string | null =>
    s === undefined ? null : s.length > ATTENTION_TEXT_MAX_LEN ? s.slice(0, ATTENTION_TEXT_MAX_LEN) : s;
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
      clampText(e.description),
      clampText(e.inputPreview),
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

/**
 * Apply a STATE-ONLY ping (turn start/complete/blocked → active/idle/waiting) to
 * a LIVE session. A single conditional UPDATE so there is no check-then-write
 * race, and deliberately NOT an upsert:
 *   - never CREATES a session (a stray ping can't conjure a ghost row; the
 *     heartbeat owns session creation),
 *   - never REVIVES an `ended` (reaped) session (`state <> 'ended'`),
 *   - when `requireNoPending` (TURN_COMPLETE → idle), only applies if the session
 *     has NO unresolved attention — a turn that ended while parked on a phone
 *     reply (AFK `message_user(expect_reply)`) must stay WAITING, atomically.
 * Backed by idx_attention_session_unresolved. Returns the resulting state, or
 * null if no live row matched (caller treats that as an accepted no-op).
 */
export async function applySessionStatePing(args: {
  sessionId: string;
  accountId: string;
  state: SessionState;
  requireNoPending: boolean;
}): Promise<SessionState | null> {
  const pendingGuard = args.requireNoPending
    ? `AND NOT EXISTS (
         SELECT 1 FROM attention_events ae
          WHERE ae.session_id = s.id AND ae.account_id = $2 AND ae.resolved = false)`
    : '';
  const row = await queryOne<{ state: string }>(
    `UPDATE sessions s SET state = $3
      WHERE s.id = $1 AND s.account_id = $2 AND s.state <> $4 ${pendingGuard}
     RETURNING s.state`,
    [args.sessionId, args.accountId, args.state, SessionState.ENDED],
  );
  return row ? (row.state as SessionState) : null;
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
 * a tap-back carrying this id binds to THIS attention (typed replies carry no
 * link — see orchestrator/safety.ts deterministicTarget). Scoped to account. Returns true
 * if a row was updated.
 */
export async function setAttentionNotifyMessageId(
  attentionId: string,
  messageId: string,
  accountId: string,
): Promise<boolean> {
  // Account-scoped: message_user passes an LLM-provided attentionId (about_request
  // / surface_request), so the write MUST be constrained to the caller's account —
  // a hallucinated/foreign id matches 0 rows rather than touching another tenant.
  const rows = await query<{ id: string }>(
    `UPDATE attention_events
        SET notify_message_id = $2
      WHERE id = $1 AND account_id = $3
      RETURNING id`,
    [attentionId, messageId, accountId],
  );
  return rows.length > 0;
}

// --- attention resolution + the session inbox ---------------------------------

/**
 * Resolve an attention event: flip `resolved` (idempotent — only the first
 * resolve wins) and enqueue the consequence onto the session inbox, atomically.
 * A PERMISSION resolves to a `verdict` row (relayed on the permission channel to
 * release the native prompt — the one structured path); a question/plan resolves
 * to a `reply` row (text injected into the session). A behavior on a non-permission
 * (approve/deny a plan) becomes a short canonical reply.
 *
 * Returns the new inbox row id, or undefined if the attention was already
 * resolved / not found (never double-resolves, never double-enqueues).
 */
export async function resolveAttention(args: {
  accountId: string;
  attentionId: string;
  behavior?: DecisionBehavior | undefined;
  answerText?: string | undefined;
}): Promise<{ inboxId: string } | undefined> {
  return withTransaction(async (client) => {
    // Claim the attention row (only if still unresolved + in this account) and
    // read what we need to deliver the consequence.
    const claim = await client.query<{
      session_id: string;
      kind: string;
      request_id: string | null;
    }>(
      `UPDATE attention_events
          SET resolved = true
        WHERE id = $1 AND account_id = $2 AND resolved = false
        RETURNING session_id, kind, request_id`,
      [args.attentionId, args.accountId],
    );
    const claimed = claim.rows[0];
    if (!claimed) return undefined;

    let ins;
    if (claimed.kind === AttentionKind.PERMISSION) {
      // Fail-CLOSED: a permission with no explicit behavior is a deny.
      const behavior = args.behavior ?? DecisionBehavior.DENY;
      ins = await client.query<{ id: string }>(
        `INSERT INTO session_inbox (session_id, account_id, kind, request_id, behavior, attention_id)
         VALUES ($1, $2, 'verdict', $3, $4, $5) RETURNING id`,
        [claimed.session_id, args.accountId, claimed.request_id, behavior, args.attentionId],
      );
    } else {
      const text =
        args.answerText ??
        (args.behavior === DecisionBehavior.ALLOW ? 'Approved — go ahead.' : 'Denied.');
      ins = await client.query<{ id: string }>(
        `INSERT INTO session_inbox (session_id, account_id, kind, text, attention_id)
         VALUES ($1, $2, 'reply', $3, $4) RETURNING id`,
        [claimed.session_id, args.accountId, text, args.attentionId],
      );
    }
    const row = ins.rows[0];
    if (!row) throw new Error('resolveAttention: inbox insert returned no row');
    return { inboxId: row.id };
  });
}

/**
 * Undelivered session-inbox rows for a device's session (oldest first). Scoped
 * so a device can only drain its OWN session's inbox. The device injects each
 * row (a `reply` as a <channel> message, a `verdict` on the permission channel),
 * then ACKs it; rows are re-served until that ACK (markInboxDelivered), so a
 * dropped SSE frame is recovered on reconnect — at-least-once + device dedup.
 */
export async function listUndeliveredInbox(args: {
  sessionId: string;
  deviceId: string;
  accountId: string;
}): Promise<InboxItem[]> {
  const rows = await query<InboxRow>(
    `SELECT si.id, si.kind, si.text, si.request_id, si.behavior, si.attention_id
       FROM session_inbox si
       JOIN sessions s ON s.id = si.session_id
      WHERE si.session_id = $1
        AND s.device_id   = $2
        AND s.account_id  = $3
        AND si.delivered_at IS NULL
      ORDER BY si.created_at ASC`,
    [args.sessionId, args.deviceId, args.accountId],
  );
  return rows.map(toInboxItem);
}

/**
 * Mark inbox rows delivered once the device confirms it injected them (by id,
 * via POST /api/device/ack) — the SINGLE delivery signal. The SSE stream serves
 * only rows where delivered_at IS NULL, so this is what stops re-serving. Scoped
 * to the device's own session so an ack can never mark another tenant's row.
 * Idempotent (already-delivered rows skipped). Returns the ids actually flipped.
 */
export async function markInboxDelivered(args: {
  sessionId: string;
  deviceId: string;
  accountId: string;
  ids: string[];
}): Promise<string[]> {
  if (args.ids.length === 0) return [];
  const rows = await query<{ id: string }>(
    `UPDATE session_inbox si
        SET delivered_at = now()
       FROM sessions s
      WHERE si.session_id = s.id
        AND si.session_id = $1
        AND s.device_id   = $2
        AND s.account_id  = $3
        AND si.account_id = $3
        AND si.id = ANY($4::uuid[])
        AND si.delivered_at IS NULL
    RETURNING si.id`,
    [args.sessionId, args.deviceId, args.accountId, args.ids],
  );
  return rows.map((r) => r.id);
}

/**
 * Look up the VERDICT (allow/deny) the user issued for a Codex-originated
 * permission, by the server-minted request_id the attention carried. The CC
 * tap-back path (orchestrator → resolveAttention) writes a `session_inbox` row
 * kind='verdict' with that request_id + behavior — the SAME row CC relays on the
 * permission channel; here the blocking /api/device/permission endpoint reads it
 * directly instead of pushing it down the SSE inbox. Scoped to session +
 * account so a device can only read its own session's verdict. Returns the
 * behavior once the verdict row exists, else undefined (still pending).
 *
 * No `delivered_at` dependency: the verdict's EXISTENCE is the signal (the
 * blocking hook is the consumer, not the device's inbox injector), so this never
 * waits on an ACK that won't come for the Codex path.
 */
export async function findVerdictForRequest(args: {
  sessionId: string;
  accountId: string;
  requestId: string;
}): Promise<DecisionBehavior | undefined> {
  const row = await queryOne<{ behavior: string | null }>(
    `SELECT behavior
       FROM session_inbox
      WHERE session_id = $1
        AND account_id = $2
        AND request_id = $3
        AND kind = 'verdict'
      ORDER BY created_at ASC
      LIMIT 1`,
    [args.sessionId, args.accountId, args.requestId],
  );
  if (!row) return undefined;
  // Fail-CLOSED: a verdict row with a null/unexpected behavior reads as DENY
  // rather than a lying cast — never an accidental allow on a malformed row.
  return row.behavior === DecisionBehavior.ALLOW ? DecisionBehavior.ALLOW : DecisionBehavior.DENY;
}

/** True once the device has ACKed injection of the inbox row `id`
 *  (session_inbox.delivered_at set). Account-scoped. Backs the orchestrator's
 *  30s delivery-confirmation watcher (see waitForDelivered's park-before-query). */
export async function isInboxDelivered(args: {
  id: string;
  accountId: string;
}): Promise<boolean> {
  const rows = await query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM session_inbox
      WHERE id = $1
        AND account_id = $2
        AND delivered_at IS NOT NULL
      LIMIT 1`,
    [args.id, args.accountId],
  );
  return rows.length > 0;
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

// --- free-text steers (a reply with no attention to resolve) ------------------

/**
 * Queue a free-text steer as a `reply` inbox row for a session ("also add
 * tests") — a message to the session that isn't answering any pending attention.
 * Tenant-scoped: inserted ONLY if the session exists, belongs to `accountId`, and
 * is not ended, so a model can never steer another account's (or a dead) session.
 * The INSERT fires NOTIFY 'session_inbox' to wake the device's event stream.
 * Returns the new id, or undefined if no matching live session.
 */
export async function enqueueReply(args: {
  sessionId: string;
  accountId: string;
  text: string;
}): Promise<{ id: string } | undefined> {
  const rows = await query<{ id: string }>(
    `INSERT INTO session_inbox (session_id, account_id, kind, text)
       SELECT s.id, s.account_id, 'reply', $3
         FROM sessions s
        WHERE s.id = $1 AND s.account_id = $2 AND s.state <> 'ended'
     RETURNING id`,
    [args.sessionId, args.accountId, args.text],
  );
  return rows[0];
}

export type { AccountRow };
