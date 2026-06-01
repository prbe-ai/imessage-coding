/**
 * @imsg/shared — shared types (the wire/data contract).
 *
 * These shapes are imported by every package. Field names are load-bearing —
 * the device plugin, control plane, transport, and dashboard all serialize to
 * and from these exact keys.
 */
import type {
  ActivityKind,
  AfkState,
  AgentKind,
  AttentionKind,
  DecisionBehavior,
  DecisionSource,
  GrantLevel,
  MessageChannel,
  SessionState,
} from './enums.ts';

/**
 * A point where the agent needs the user's attention (permission prompt,
 * question, plan to approve, idle nudge, or turn-complete signal).
 * Emitted by the device plugin, stored account-scoped by the control plane.
 */
export interface AttentionEvent {
  id: string;
  deviceId: string;
  sessionId: string;
  kind: AttentionKind;
  /** Tool that triggered a permission prompt (e.g. "Bash", "Write"). */
  toolName?: string;
  /** Human-readable description of what's being asked. */
  description?: string;
  /** Truncated preview of the tool input / question body. */
  inputPreview?: string;
  /** Channels protocol request_id for a permission prompt (verdict target). */
  requestId?: string;
  /** Correlation id tagged on a question/plan relayed via the reply tool. */
  qid?: string;
  /**
   * Provider message id of the OUTBOUND phone notification that fronted this
   * attention (set when the control plane notified the phone). Tapbacks/inline
   * replies that carry this id bind deterministically to THIS attention — the
   * canonical, server-issued binding target (vs. the device-side requestId/qid).
   */
  notifyMessageId?: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/**
 * The resolution of an AttentionEvent. A permission yields `behavior`
 * (+ optional `grant` escalation); a question/plan yields `answerText`.
 * `source` records how it was resolved (phone reply, dashboard, local
 * keyboard, or a timeout fallback — which is always fail-closed, never allow).
 */
export interface Decision {
  attentionId: string;
  behavior?: DecisionBehavior;
  answerText?: string;
  grant?: GrantLevel;
  /** ISO-8601 timestamp. */
  resolvedAt: string;
  source: DecisionSource;
}

/**
 * Live view of a Claude Code session as tracked by the control plane.
 */
export interface SessionInfo {
  id: string;
  deviceId: string;
  cwd?: string;
  agent: AgentKind;
  /** ISO-8601 timestamp of the most recent event on this session. */
  lastEventAt: string;
  state: SessionState;
  afk: AfkState;
  grant: GrantLevel;
}

/**
 * One surfaced unit of session activity (the AFK transcript tap). The device
 * derives these from the Claude Code transcript and ships them ONLY while AFK.
 * `lineNo`+`blockIdx` is the transcript position — a stable idempotency key so a
 * re-read (crash before cursor commit) never double-inserts server-side.
 *
 * Deliberately lightweight: it carries WHAT the session is doing, never the full
 * data. Tool inputs become a one-line `summary`; tool RESULTS carry no content
 * (only `isError` when a step failed); thinking blocks are dropped entirely.
 */
export interface ActivityEvent {
  /** Transcript line index (0-based within the session). */
  lineNo: number;
  /** Block index within that line's message content (one line → many blocks). */
  blockIdx: number;
  kind: ActivityKind;
  /** Tool name for a TOOL_USE marker (e.g. "Bash", "Edit"). */
  toolName?: string;
  /** Message text for USER_MESSAGE / ASSISTANT_TEXT (sanitized, capped). */
  text?: string;
  /** One-line summary of a TOOL_USE input (command/path/pattern/…, capped). */
  summary?: string;
  /** True for a failed TOOL_RESULT (the only tool-result we surface). */
  isError?: boolean;
  /** ISO-8601 timestamp the device observed the block. */
  at: string;
}

/**
 * A batch of ActivityEvents for one session, POSTed to /api/device/activity.
 * `sessionId` is CC's real transcript session id; `cwd` lets the route register
 * the session (project dir) if the heartbeat hasn't yet.
 */
export interface ActivityBatchBody {
  sessionId: string;
  cwd?: string;
  events: ActivityEvent[];
}

/** One prior message AgentPhone includes for conversational context. */
export interface RecentMessage {
  content?: string;
  direction?: string;
  channel?: string;
  at?: string;
}

/**
 * Inbound message webhook shape from the messaging provider (agentphone).
 * NOTE: exact provider field names are mapped inside @imsg/transport's
 * parseInbound(); this is the normalized internal shape.
 */
export interface InboundMessage {
  /** Sender phone number (E.164). */
  from: string;
  text: string;
  channel: MessageChannel;
  /** Conversation/thread id grouping every message with this sender. */
  conversationId?: string;
  /** Provider conversation metadata (top-level `conversationState`), if any. */
  conversationState?: Record<string, unknown>;
  /** Recent message history the provider includes for context, if any. */
  recentHistory?: RecentMessage[];
  /** If this is a reaction/tapback, the id of the agent message it targets. */
  reactionTo?: string;
  /**
   * Per-delivery id (AgentPhone's `X-Webhook-ID`). Unique per inbound message
   * and stable across the provider's retries — the natural idempotency key,
   * though nothing dedupes on it yet. Inbound messages carry no body-level id,
   * so this is the only per-message handle.
   */
  messageId: string;
}

/**
 * Outbound message to send via the transport.
 */
export interface OutboundMessage {
  /** Recipient phone number (E.164). */
  to: string;
  text: string;
  /** Provider message id to thread/reply against. */
  replyToMessageId?: string;
}
