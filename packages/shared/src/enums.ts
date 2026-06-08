/**
 * @imsg/shared — enums & const-objects.
 *
 * Global rule: never hardcode a string that belongs in an enum. Every package
 * imports these const-objects; consumers MUST reference e.g.
 * `ChannelMethod.PERMISSION_REQUEST` rather than the literal string.
 *
 * We use `as const` object maps (not TS `enum`) so the values are plain string
 * literals at runtime (no reverse-mapping, tree-shakeable) and the derived
 * union types are exact.
 */

// -----------------------------------------------------------------------------
// Claude Code Channels protocol — method names (see channels-reference).
// Verified against the validated spike (plugins/imsg-spike/channel.ts).
// -----------------------------------------------------------------------------
export const ChannelMethod = {
  /** Push an inbound <channel> message INTO the session. */
  CHANNEL: 'notifications/claude/channel',
  /** Claude Code notifies us a permission dialog opened (relay OUT). */
  PERMISSION_REQUEST: 'notifications/claude/channel/permission_request',
  /** We send a permission verdict back (relay IN). */
  PERMISSION: 'notifications/claude/channel/permission',
} as const;
export type ChannelMethod = (typeof ChannelMethod)[keyof typeof ChannelMethod];

// -----------------------------------------------------------------------------
// Notification kinds surfaced to the phone.
// -----------------------------------------------------------------------------
export const NotificationType = {
  PERMISSION_PROMPT: 'permission_prompt',
  IDLE_PROMPT: 'idle_prompt',
} as const;
export type NotificationType =
  (typeof NotificationType)[keyof typeof NotificationType];

// -----------------------------------------------------------------------------
// Permission verdict behavior.
// -----------------------------------------------------------------------------
export const DecisionBehavior = {
  ALLOW: 'allow',
  DENY: 'deny',
} as const;
export type DecisionBehavior =
  (typeof DecisionBehavior)[keyof typeof DecisionBehavior];

// -----------------------------------------------------------------------------
// AFK (away-from-keyboard) state for a session.
// -----------------------------------------------------------------------------
export const AfkState = {
  ON: 'on',
  OFF: 'off',
} as const;
export type AfkState = (typeof AfkState)[keyof typeof AfkState];

// -----------------------------------------------------------------------------
// The single MCP tool the coding agent calls to reach the user (channel bridge
// OUT). Declared here so the MCP registration (channel.ts) and the transcript
// scan that detects whether the agent reported this turn (transcript.ts, used by
// the AFK Stop gate) agree on one identifier. In a transcript the call appears
// fully-qualified as `mcp__<server>__message_user`, so matchers should also
// accept a `__message_user` suffix.
// -----------------------------------------------------------------------------
export const MESSAGE_USER_TOOL = 'message_user';

// -----------------------------------------------------------------------------
// MCP tool the agent calls to set/update this session's display name as work
// progresses. Writes sessions.title directly (single column, last-writer-wins);
// it survives the heartbeat because the device ships its auto-title edge-triggered
// (only on change), so a steady beat never re-asserts over the rename. The same
// 'rename_session' id is reused for the orchestrator's server-side rename tool
// (ToolName.RENAME_SESSION). Declared here so the registration (channel.ts) and
// any future transcript matcher share one identifier.
// -----------------------------------------------------------------------------
export const RENAME_SESSION_TOOL = 'rename_session';

// -----------------------------------------------------------------------------
// Why the agent is asking for the user's attention.
// -----------------------------------------------------------------------------
export const AttentionKind = {
  PERMISSION: 'permission',
  QUESTION: 'question',
  PLAN: 'plan',
  IDLE: 'idle',
  TURN_COMPLETE: 'turn_complete',
  // State-only kinds: drive sessions.state, never a surfaced attention.
  TURN_START: 'turn_start', // a turn started → active
  BLOCKED: 'blocked', // a native question/plan opened at the keyboard → waiting
} as const;
export type AttentionKind = (typeof AttentionKind)[keyof typeof AttentionKind];

// -----------------------------------------------------------------------------
// How the server agent resolves a pending request (permission / question / plan)
// the coding agent is blocked on — the underlying decision vocabulary. The
// orchestrator exposes a SUBSET on `message_agent`'s `action` (allow/deny/approve);
// answering is just sending text. The control plane validates against the kind.
// -----------------------------------------------------------------------------
export const RequestAction = {
  /** Answer a question/plan with free text (becomes the agent's prompt input). */
  ANSWER: 'answer',
  /** Approve a plan. */
  APPROVE: 'approve',
  /** Deny / reject a permission or plan. Always safe. */
  DENY: 'deny',
  /** Allow a permission (destructive ones pass the deterministic gate in code). */
  ALLOW: 'allow',
} as const;
export type RequestAction = (typeof RequestAction)[keyof typeof RequestAction];

// -----------------------------------------------------------------------------
// Orchestrator (assistant turn) tool surface. The model talks to the user and to
// the coding agents through exactly these six tools — two messaging, two read,
// two write. Reference these names in the schema (prompt.ts) and the dispatcher
// (orchestrator/index.ts); never hardcode the literal strings.
//   - MESSAGE_USER         text the user (multiple short messages welcome; can
//                          surface a pending request as a tap-backable message)
//   - MESSAGE_AGENT        send text to a coding agent (steer OR answer — it's all
//                          text), or an allow/deny/approve verdict on a blocked one
//   - GET_SESSION_STATE    read: what each agent is doing + what it's blocked on
//   - GET_SESSION_DATA     read: an agent's activity log (recent / grep / line range)
//   - UPDATE_SESSION_STATE write: change a session setting (afk only, for now)
//   - RENAME_SESSION       write: set a session's display label (when the user asks
//                          or the label has drifted from the work) — shares the
//                          `rename_session` id with the device-side MCP tool
// -----------------------------------------------------------------------------
export const ToolName = {
  MESSAGE_USER: 'message_user',
  MESSAGE_AGENT: 'message_agent',
  GET_SESSION_STATE: 'get_session_state',
  GET_SESSION_DATA: 'get_session_data',
  UPDATE_SESSION_STATE: 'update_session_state',
  RENAME_SESSION: RENAME_SESSION_TOOL,
} as const;
export type ToolName = (typeof ToolName)[keyof typeof ToolName];

// -----------------------------------------------------------------------------
// Observability ledger (`turns` table). The orchestrator is otherwise a black
// box: a "Read, no reply" could be the model choosing silence, the turn
// erroring, a coalesce-abort, or a steer with no user-facing text. Each turn
// records what TRIGGERED it and how it ENDED so that's a query, not a guess.
// Referenced by the recorder (orchestrator/index.ts) and the repo writer
// (db/repo.ts insertTurn); never hardcode the literal strings.
// -----------------------------------------------------------------------------
export const TurnTrigger = {
  /** An inbound user text (webhook → coalesced drain). */
  USER_MESSAGE: 'user_message',
  /** A coding agent needs attention (permission / question / plan / idle). */
  AGENT_EVENT: 'agent_event',
  /** A coding agent's fire-and-forget status/result relay. */
  AGENT_MESSAGE: 'agent_message',
} as const;
export type TurnTrigger = (typeof TurnTrigger)[keyof typeof TurnTrigger];

export const TurnOutcome = {
  /** The assistant texted the user. */
  REPLIED: 'replied',
  /** The assistant took an action (steer / resolve / notify) but sent no text. */
  ACTED: 'acted',
  /** The assistant produced nothing — no text, no action (the silent black box). */
  SILENT: 'silent',
  /** The turn threw; a safe fallback was sent. */
  ERRORED: 'errored',
  /** Interrupted before committing a side effect (a newer inbound coalesced in). */
  ABORTED: 'aborted',
} as const;
export type TurnOutcome = (typeof TurnOutcome)[keyof typeof TurnOutcome];

// -----------------------------------------------------------------------------
// Session activity (the realtime transcript tap). One per surfaced transcript block:
// a user message, an assistant reply, a tool call marker, or a failed tool call.
// Deliberately coarse — it captures WHAT a session is doing, not the full data.
// -----------------------------------------------------------------------------
export const ActivityKind = {
  USER_MESSAGE: 'user_message',
  ASSISTANT_TEXT: 'assistant_text',
  TOOL_USE: 'tool_use',
  TOOL_RESULT: 'tool_result',
} as const;
export type ActivityKind = (typeof ActivityKind)[keyof typeof ActivityKind];

// -----------------------------------------------------------------------------
// Device API routes (control plane).
// -----------------------------------------------------------------------------
export const DeviceApiRoute = {
  PAIR: '/api/device/pair',
  ATTENTION: '/api/device/attention',
  /** SSE event stream: the session inbox (one row = one thing to deliver to the
   *  session — a reply or a permission verdict) plus afk state. Replaces polling. */
  EVENTS: '/api/device/events',
  /** Device confirms it injected inbox rows (by id) so the server marks them
   *  delivered and stops re-serving them — at-least-once + dedup. */
  ACK: '/api/device/ack',
  HEARTBEAT: '/api/device/heartbeat',
  STATE: '/api/device/state',
  /** Lightweight, realtime (killswitch-gated) session-transcript activity batches (the tap). */
  ACTIVITY: '/api/device/activity',
  /** Fire-and-forget agent→user message (status/result). The server agent relays
   *  it and drops it — it is NEVER an attention and has no `resolved` lifecycle. */
  MESSAGE: '/api/device/message',
  /** Agent-set display name (the `rename_session` tool). Writes sessions.title
   *  directly (last-writer-wins, single column). It does NOT get clobbered by the
   *  heartbeat because the device ships its auto-title EDGE-TRIGGERED — only when
   *  its own title actually changes, never re-asserted every beat. An empty name
   *  is a no-op (a label is never blank). */
  SESSION_TITLE: '/api/device/session-title',
  /** BLOCKING approve-and-resume for agents with no native verdict-push channel
   *  (Codex). A PreToolUse/PermissionRequest hook POSTs the pending destructive
   *  tool here and the request HANGS until the user's tap-back verdict arrives or
   *  the server's own deadline fires (which returns an explicit deny — never a
   *  lapse), then the hook allows/denies the parked command. The control-plane
   *  deadline MUST be shorter than the hook's timeout so a timeout is a clean deny,
   *  not a fall-through to the unattended local prompt. */
  PERMISSION: '/api/device/permission',
} as const;
export type DeviceApiRoute = (typeof DeviceApiRoute)[keyof typeof DeviceApiRoute];

// -----------------------------------------------------------------------------
// Dashboard API routes. EVENTS is the account-scoped SSE stream the dashboard
// browser opens DIRECTLY against the control plane (the single SSE hub + source
// of truth); SSE_TICKET is the dashboard's same-origin Next route that mints the
// short-TTL HMAC ticket the browser passes to EVENTS (EventSource can't set
// Authorization headers, so auth rides as a `?ticket=` query param).
// -----------------------------------------------------------------------------
export const DashboardApiRoute = {
  /** Control-plane SSE: pushes the account's live `sessions` list. */
  EVENTS: '/api/dashboard/events',
  /** Dashboard same-origin: GET → { ticket } for the EVENTS stream. */
  SSE_TICKET: '/api/home/sse-ticket',
  /** Dashboard same-origin: POST → set a session's display name (the user-side
   *  counterpart to the agent's rename_session tool). Writes sessions.title
   *  (account-scoped, last-writer-wins); an empty name is a no-op. */
  SESSION_TITLE: '/api/home/session-title',
} as const;
export type DashboardApiRoute =
  (typeof DashboardApiRoute)[keyof typeof DashboardApiRoute];

// -----------------------------------------------------------------------------
// SSE `event:` names on the control-plane streams (device + dashboard). Both the
// server writer (streamSSE) and the client frame-parser MUST reference these.
// -----------------------------------------------------------------------------
export const SseEvent = {
  /** Device stream: the session inbox — rows to deliver into the session (a
   *  `reply` to inject as a <channel> message, or a permission `verdict`). */
  INBOX: 'inbox',
  /** Device stream: a session's current { afk } (push-down sync). */
  STATE: 'state',
  /** Dashboard stream: the account's live `sessions` list. */
  SESSIONS: 'sessions',
  /** Dashboard stream: the account's `devices` list (afk lives here). */
  DEVICES: 'devices',
  /** Keepalive on both streams (ignored by clients). */
  PING: 'ping',
} as const;
export type SseEvent = (typeof SseEvent)[keyof typeof SseEvent];

// -----------------------------------------------------------------------------
// Postgres LISTEN/NOTIFY channels (control-plane listener ↔ schema triggers).
// Each notification payload carries a `session_id` and/or `account_id`.
// -----------------------------------------------------------------------------
export const NotifyChannel = {
  /** Fired on a session_inbox INSERT (wake the device's event stream to flush
   *  the new row). Payload carries session_id + account_id. */
  SESSION_INBOX: 'session_inbox',
  /** Fired on a sessions state change (wake device + dashboard). */
  SESSION_STATE: 'session_state',
  /** Fired on a device afk change — the machine-wide toggle (wake every
   *  live device stream + the dashboard). Payload carries device_id + account_id. */
  DEVICE_STATE: 'device_state',
  /** Fired when a session_inbox row's delivered_at flips non-null (the device
   *  ACKed injection). Wakes the orchestrator's 30s confirmation watcher, keyed
   *  by the row id. Payload: { id }. */
  INBOX_DELIVERED: 'inbox_delivered',
} as const;
export type NotifyChannel = (typeof NotifyChannel)[keyof typeof NotifyChannel];

// -----------------------------------------------------------------------------
// Transport events (inbound from the messaging provider webhook).
// -----------------------------------------------------------------------------
export const TransportEvent = {
  AGENT_MESSAGE: 'agent.message',
  AGENT_REACTION: 'agent.reaction',
} as const;
export type TransportEvent = (typeof TransportEvent)[keyof typeof TransportEvent];

// -----------------------------------------------------------------------------
// Supporting enumerations referenced by the shared types below.
// -----------------------------------------------------------------------------

/** Lifecycle state of a Claude Code session. */
export const SessionState = {
  ACTIVE: 'active',
  WAITING: 'waiting',
  IDLE: 'idle',
  ENDED: 'ended',
} as const;
export type SessionState = (typeof SessionState)[keyof typeof SessionState];

/** Which coding agent a session is running. */
export const AgentKind = {
  CLAUDE_CODE: 'claude-code',
  CODEX: 'codex',
} as const;
export type AgentKind = (typeof AgentKind)[keyof typeof AgentKind];

/** Messaging channel an inbound message arrived on. */
export const MessageChannel = {
  IMESSAGE: 'imessage',
  SMS: 'sms',
  MMS: 'mms',
  VOICE: 'voice',
} as const;
export type MessageChannel = (typeof MessageChannel)[keyof typeof MessageChannel];

/** Direction of a logged message relative to the agent. */
export const MessageDirection = {
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
} as const;
export type MessageDirection =
  (typeof MessageDirection)[keyof typeof MessageDirection];
