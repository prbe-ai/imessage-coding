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
} as const;
export type AttentionKind = (typeof AttentionKind)[keyof typeof AttentionKind];

// -----------------------------------------------------------------------------
// Session activity (the AFK transcript tap). One per surfaced transcript block:
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
  HEARTBEAT: '/api/device/heartbeat',
  STATE: '/api/device/state',
  /** Lightweight, AFK-gated session-transcript activity batches (the tap). */
  ACTIVITY: '/api/device/activity',
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
  /** Fired on a sessions afk/grant/state change (wake device + dashboard). */
  SESSION_STATE: 'session_state',
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
