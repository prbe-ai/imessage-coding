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
 * One row of the session inbox — the SINGLE thing the control plane delivers
 * into a coding-agent session. Two kinds, the only structural branch left:
 *   - `reply`   → `text` is injected into the session as a <channel> message.
 *                 Covers question answers, plan approvals/denials, AND free-text
 *                 steers — from the user's side, "a simple reply".
 *   - `verdict` → `{ requestId, behavior }` is relayed on the permission channel
 *                 to release a native Claude Code permission prompt. Irreducible:
 *                 a parked permission dialog can only be unblocked by a structured
 *                 allow/deny carrying its request_id (text can't release it).
 * The device injects each row at most once (dedup by `id`) and ACKs it; the
 * server sets `delivered_at` on that ACK and re-serves until then.
 */
export interface InboxItem {
  id: string;
  kind: 'reply' | 'verdict';
  /** reply: the text to inject. */
  text?: string;
  /**
   * reply: whether the user is AWAITING an answer (true) or this is a steer/FYI
   * (false/absent). The device surfaces it to the agent so it knows whether to
   * explicitly reply via message_user — Claude Code as an `expect_reply` attribute on
   * the <channel> tag, Codex as a directive folded into the injected turn. Unused for
   * a verdict.
   */
  expectReply?: boolean;
  /** verdict: the Channels request_id of the permission prompt to release. */
  requestId?: string;
  /** verdict: the permission decision. */
  behavior?: DecisionBehavior;
  /** The attention this delivers the consequence of (for <channel> meta), if any. */
  attentionId?: string;
}

/**
 * Live view of a Claude Code session as tracked by the control plane.
 */
export interface SessionInfo {
  id: string;
  deviceId: string;
  cwd?: string;
  /**
   * Human label for the session. Prefers Claude Code's own title — its
   * LLM-generated `ai-title`, or a `/rename` custom-title — and falls back to the
   * first user message (provisional) until one appears. Lets the dashboard +
   * orchestrator name a session by what it's doing instead of an opaque id +
   * folder. Upgrades in place (the server keeps the newest non-null value);
   * absent until a title is observed, when readers fall back to the cwd basename.
   */
  title?: string;
  agent: AgentKind;
  /** ISO-8601 timestamp of the most recent event on this session. */
  lastEventAt: string;
  state: SessionState;
  afk: AfkState;
}

/** Max length of a session `title` (chars). Capped device-side at capture and
 *  re-clamped server-side as defense-in-depth. */
export const SESSION_TITLE_MAX_LEN = 80;

/** Normalize any session label (tap auto-title or a deliberate rename) to a
 *  single trimmed line within the length cap. Shared so the tap's capture path,
 *  the agent's `rename_session` tool, the dashboard edit, and the orchestrator's
 *  rename tool clean names identically. Returns '' for whitespace-only input;
 *  every caller treats empty as "not a rename" — a session label is never blank
 *  (the plug-in always seeds one), so an empty result is a no-op, never a clear. */
export function cleanSessionTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_MAX_LEN);
}

/** Max length (chars) of an attention `description` / `inputPreview` the control
 *  plane will store. Capped device-side at egress (`sanitizeText`); re-clamped
 *  server-side as defense-in-depth so a forged/buggy client can't bloat the
 *  orchestrator prompt with an oversized body. Generous on purpose — a real
 *  question or preview is far shorter; this is purely an upper bound on abuse,
 *  not the display limit (the orchestrator renders a `description` in full). */
export const ATTENTION_TEXT_MAX_LEN = 4_000;

/** Max length (chars) of a VERBATIM `message_user` relay — text the user sees as-is
 *  with the orchestrator LLM bypassed. Sized to ≈ one iPhone screenful at the default
 *  text size (derived from bubble geometry: ~30 lines × ~33 chars on a standard
 *  iPhone), so a raw plan dump can't flood the thread. FAR smaller than
 *  ATTENTION_TEXT_MAX_LEN because verbatim text is shown unshaped, not just stored.
 *  The cap is a GATE, not a truncator: text over it is NOT sent verbatim — it falls
 *  back to the orchestrator, which condenses it to fit (no silent tail-chopping). */
export const VERBATIM_TEXT_MAX_LEN = 1_000;

/** Whether `text` is short enough to send verbatim (≤ one screen). When false the
 *  caller must fall back to the orchestrator relay (which condenses to fit) rather
 *  than truncate — so the tail of a long plan is never silently dropped. Pure. */
export function fitsVerbatim(text: string): boolean {
  return text.length <= VERBATIM_TEXT_MAX_LEN;
}

/** Strip control + zero-width + bidi chars from text headed straight to the user,
 *  WITHOUT touching structure: tab/newline/CR and quotes survive (a verbatim plan or
 *  diff needs its line breaks and quotes), but C0/C1 controls, zero-width joiners, and
 *  right-to-left overrides are removed so a crafted/forged message can't spoof the
 *  `[Agent: …]` attribution or scramble the thread. Mirrors the server's
 *  sanitizeOutbound control/bidi class, minus the `"` strip (irrelevant for text sent
 *  to iMessage rather than embedded in a prompt). Verbatim bypasses the orchestrator
 *  LLM, so this is the server-side scrub the device sanitizer is meant to complement.
 *  Pure. */
export function stripControlBidi(text: string): string {
  // C0/C1 controls except tab/newline/CR, zero-width marks, and bidi
  // overrides/isolates -- mirrors sanitizeOutbound's class minus the quote strip.
  return text.replace(
    /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g,
    '',
  );
}

/**
 * A paired machine, as tracked by the control plane. AFK is MACHINE-WIDE (the
 * PreToolUse hook reads one shared state file per device), so it lives here, not
 * on the session — a device toggle is the single source of truth that every live
 * session on the device syncs down. `label` is a friendly name (hostname → os →
 * short id); `sessionCount` is the device's live sessions.
 */
export interface DeviceInfo {
  id: string;
  /** Friendly name for display: hostname, else os, else the short id. */
  label: string;
  os?: string;
  hostname?: string;
  afk: AfkState;
  /** Killswitch state: revoked_at IS NULL AND disabled_at IS NULL. */
  enabled: boolean;
  /** Count of the device's non-ended sessions. */
  sessionCount: number;
}

/** One of the user's paired machines, as a fact about them for the orchestrator
 *  prompt (not the killswitch/afk-bearing DeviceInfo). hostname/os are
 *  device-reported and may be absent. */
export interface UserMachine {
  hostname?: string;
  os?: string;
}

/**
 * The little we know about the human on the other end of a conversation, surfaced
 * read-only into the assistant's system prompt so it can be personal (name their
 * machines, know who it serves). NO new storage: `email` is the account row,
 * `phone` the verified conversation number, `machines` their non-revoked devices.
 */
export interface UserProfile {
  email: string;
  /** Most-recently-verified phone number for the account, if any. */
  phone?: string;
  /** Non-revoked paired machines, most-recently-paired first (may be empty). */
  machines: UserMachine[];
}

/**
 * One surfaced unit of session activity (the transcript tap). The device derives
 * these from the Claude Code transcript and ships them in REALTIME whenever the
 * killswitch permits (no longer AFK-gated) — so the control plane's activity log
 * stays current for get_session_data and the orchestrator snapshot.
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
 * `sessionId` is the real transcript session id; `cwd` lets the route register
 * the session (project dir) if the heartbeat hasn't yet. `agent` lets the tap
 * label the session correctly when IT registers the row before the channel's
 * first heartbeat — otherwise a codex session would be born `claude-code`.
 */
export interface ActivityBatchBody {
  sessionId: string;
  cwd?: string;
  agent?: AgentKind;
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
  /**
   * Set ONLY for a tap-back (iMessage reaction): the id of the agent message it
   * targets. This is the only inbound reply linkage AgentPhone forwards — a typed
   * inline reply carries NO target (verified live 2026-06-02), so it never
   * populates this field and cannot be bound to a specific message.
   */
  reactionTo?: string;
  /**
   * Per-delivery id (AgentPhone's `X-Webhook-ID`, e.g. `del_<messageId>_<numberId>`).
   * Stable across the provider's retries — the idempotency / dedup key. NOT a valid
   * reply target on its own (passing the whole string 404s); the real message id is
   * the embedded segment — see `providerMessageId`.
   */
  messageId: string;
  /**
   * The provider's REAL message id, parsed from `messageId` (the middle segment of
   * `del_<messageId>_<numberId>`). A valid `OutboundMessage.replyToMessageId` target,
   * available race-free at receipt (no conversation lookup). Undefined if the
   * X-Webhook-ID isn't in the expected shape.
   */
  providerMessageId?: string;
  /**
   * Image attachment URLs from the provider (MMS / iMessage photos), normalized
   * from the webhook `data.mediaUrl` (and any plural `mediaUrls`). The control
   * plane fetches + base64-encodes these into the LLM turn — see
   * orchestrator/media.ts. Only a vision-capable backend (gemini-3.5-flash) can
   * read them; image turns are routed there regardless of the text default.
   * Absent/empty when the message carried no media.
   */
  mediaUrls?: string[];
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
