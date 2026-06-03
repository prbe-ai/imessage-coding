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
// Standing grant level for a session (how much can auto-proceed while AFK).
// -----------------------------------------------------------------------------
export const GrantLevel = {
  OFF: 'off',
  EDITS: 'edits',
  FULL: 'full',
} as const;
export type GrantLevel = (typeof GrantLevel)[keyof typeof GrantLevel];

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
  /** Approve a plan (optionally with a standing edits grant). */
  APPROVE: 'approve',
  /** Deny / reject a permission or plan. Always safe. */
  DENY: 'deny',
  /** Allow a permission (destructive ones pass the deterministic gate in code). */
  ALLOW: 'allow',
} as const;
export type RequestAction = (typeof RequestAction)[keyof typeof RequestAction];

// -----------------------------------------------------------------------------
// Orchestrator (assistant turn) tool surface. The model talks to the user and to
// the coding agents through exactly these five tools — two messaging, two read,
// one write. Reference these names in the schema (prompt.ts) and the dispatcher
// (orchestrator/index.ts); never hardcode the literal strings.
//   - MESSAGE_USER         text the user (multiple short messages welcome; can
//                          surface a pending request as a tap-backable message)
//   - MESSAGE_AGENT        send text to a coding agent (steer OR answer — it's all
//                          text), or an allow/deny/approve verdict on a blocked one
//   - GET_SESSION_STATE    read: what each agent is doing + what it's blocked on
//   - GET_SESSION_DATA     read: an agent's activity log (recent / grep / line range)
//   - UPDATE_SESSION_STATE write: change a session setting (afk only, for now)
// -----------------------------------------------------------------------------
export const ToolName = {
  MESSAGE_USER: 'message_user',
  MESSAGE_AGENT: 'message_agent',
  GET_SESSION_STATE: 'get_session_state',
  GET_SESSION_DATA: 'get_session_data',
  UPDATE_SESSION_STATE: 'update_session_state',
} as const;
export type ToolName = (typeof ToolName)[keyof typeof ToolName];

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
  DECISIONS: '/api/device/decisions',
  /** SSE event stream (decisions + session-message steers) — replaces polling. */
  EVENTS: '/api/device/events',
  /** Device confirms it injected decisions (by attentionId) so the server can
   *  mark them delivered and stop re-serving them — at-least-once + dedup. */
  ACK: '/api/device/ack',
  HEARTBEAT: '/api/device/heartbeat',
  STATE: '/api/device/state',
  /** Lightweight, realtime (killswitch-gated) session-transcript activity batches (the tap). */
  ACTIVITY: '/api/device/activity',
  /** Fire-and-forget agent→user message (status/result). The server agent relays
   *  it and drops it — it is NEVER an attention and has no `resolved` lifecycle. */
  MESSAGE: '/api/device/message',
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
} as const;
export type DashboardApiRoute =
  (typeof DashboardApiRoute)[keyof typeof DashboardApiRoute];

// -----------------------------------------------------------------------------
// SSE `event:` names on the control-plane streams (device + dashboard). Both the
// server writer (streamSSE) and the client frame-parser MUST reference these.
// -----------------------------------------------------------------------------
export const SseEvent = {
  /** Device stream: resolved decisions (verdicts/answers/grants). */
  DECISIONS: 'decisions',
  /** Device stream: free-text steering messages to inject. */
  SESSION_MESSAGES: 'session_messages',
  /** Device stream: a session's current { afk, grant } (push-down sync). */
  STATE: 'state',
  /** Dashboard stream: the account's live `sessions` list. */
  SESSIONS: 'sessions',
  /** Dashboard stream: the account's `devices` list (afk/grant live here). */
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
  /** Fired on a decisions INSERT (wake the device's verdict/answer waiter). */
  DECISION_READY: 'decision_ready',
  /** Fired on a session_messages INSERT (wake the device's steer waiter). */
  SESSION_MESSAGE: 'session_message',
  /** Fired on a sessions state change (wake device + dashboard). */
  SESSION_STATE: 'session_state',
  /** Fired on a device afk/grant change — the machine-wide toggle (wake every
   *  live device stream + the dashboard). Payload carries device_id + account_id. */
  DEVICE_STATE: 'device_state',
  /** Fired when a decision's delivered_at flips non-null (the device ACKed
   *  injection). Wakes the orchestrator's delivery-confirmation waiter, keyed by
   *  the attention_id. Payload: { id }. */
  DECISION_DELIVERED: 'decision_delivered',
  /** Fired when a session_message's acked_at flips non-null (the device ACKed
   *  injection). Wakes the delivery-confirmation waiter, keyed by the message id.
   *  Payload: { id }. (Separate from delivered_at, which stays server-side dedup.) */
  MESSAGE_DELIVERED: 'message_delivered',
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

/** Where a decision was resolved. */
export const DecisionSource = {
  PHONE: 'phone',
  DASHBOARD: 'dashboard',
  KEYBOARD: 'keyboard',
  TIMEOUT: 'timeout',
} as const;
export type DecisionSource = (typeof DecisionSource)[keyof typeof DecisionSource];

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
