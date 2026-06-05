/**
 * @imsg/transport — AgentPhone concrete implementation of the Transport port.
 *
 * Env contract:
 *   AGENTPHONE_API_KEY         (required for send)
 *   AGENTPHONE_API_BASE        (default https://api.agentphone.ai)
 *   AGENTPHONE_AGENT_ID        (required for send)
 *   AGENTPHONE_WEBHOOK_SECRET  (required for verifyWebhook — HARD FAIL if absent)
 *
 * SECURITY:
 *   - verifyWebhook() computes HMAC-SHA256 over the RAW request body bytes,
 *     compares in constant time (crypto.timingSafeEqual), and HARD-FAILS when
 *     the webhook secret is missing/empty. It NEVER no-ops to `true`.
 *   - REPLAY DEFENSE: when a signed timestamp is present it must be a numeric
 *     epoch within ±300s of now and the signature must match the
 *     timestamp-bound HMAC; stale/forged timestamps are rejected (fail-closed).
 *
 * Provider field names below are taken from the AgentPhone docs and are marked
 * /* VERIFY against live API *\/ where uncertain. The whole impl sits behind the
 * Transport interface so the provider is swappable.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  MessageChannel,
  TransportEvent,
  type InboundMessage,
  type OutboundMessage,
  type RecentMessage,
} from '@imsg/shared';
import type { ReplyTargetMessage, SendResult, Transport } from './transport.ts';

/** AgentPhone API origin used when `AGENTPHONE_API_BASE` is unset. Exported so
 *  the orchestrator can host-gate the API key when fetching inbound media (only
 *  attach the bearer to AgentPhone's own host — see orchestrator/media.ts). */
export const DEFAULT_API_BASE = 'https://api.agentphone.ai';

/**
 * Default number of recent conversation messages to scan when listing inbound
 * reply targets (`resolveRecentInboundMessages`). The newest messages are at the
 * head; a small window keeps the lookup cheap while tolerating a few interleaved
 * outbound/reaction rows.
 */
const CONVERSATION_LOOKUP_LIMIT = 10;

/**
 * Hard cap on the inbound-id lookup. This GET runs inside the turn's gating
 * Promise.all, so a hung conversations endpoint would otherwise stall the whole
 * user turn (the catch only covers thrown errors, not a hang). Bounding it keeps
 * threading a true best-effort nicety: on timeout we abort and send un-threaded.
 */
const CONVERSATION_LOOKUP_TIMEOUT_MS = 4_000;

/**
 * Max allowed clock skew (seconds) between the signed webhook timestamp and now.
 * A signature older/newer than this is rejected as a replay. 5 minutes mirrors
 * the common provider convention (Stripe/Svix use the same window).
 */
const WEBHOOK_MAX_SKEW_SECONDS = 300;

// Webhook header + envelope shape verified against the live docs (2026-05-31):
// https://docs.agentphone.ai/documentation/guides/webhooks
// AgentPhone signs each delivery as
//   sha256=<hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))>
// and sends the signature/timestamp/id in the X-Webhook-* headers below.

/** Header carrying the `sha256=<hex>` HMAC signature. */
export const AGENTPHONE_SIGNATURE_HEADER = 'x-webhook-signature';
/** Header carrying the signed Unix-epoch timestamp (seconds). */
export const AGENTPHONE_TIMESTAMP_HEADER = 'x-webhook-timestamp';
/**
 * Header carrying the unique per-delivery id. It is the idempotency key
 * (stable across retries) and our only per-message handle — inbound messages
 * have no body-level id.
 */
export const AGENTPHONE_WEBHOOK_ID_HEADER = 'x-webhook-id';

export interface AgentPhoneConfig {
  apiKey?: string;
  apiBase?: string;
  agentId?: string;
  webhookSecret?: string;
}

/**
 * AgentPhone webhook envelope. `channel`, `conversationState`, and
 * `recentHistory` are TOP-LEVEL; the message text and sender live under `data`.
 */
interface AgentPhoneWebhookEnvelope {
  event?: string; // "agent.message" | "agent.reaction" | "agent.call_ended"
  channel?: string; // "sms" | "mms" | "imessage" | "voice"
  agentId?: string;
  data?: AgentPhoneEventData;
  conversationState?: Record<string, unknown>;
  recentHistory?: RecentMessage[];
}

/**
 * The `data` object. Fields are the union of the message-event shape
 * (sms/mms/imessage) and the reaction-event shape; all optional because which
 * set is present depends on `event`.
 */
interface AgentPhoneEventData {
  // agent.message
  conversationId?: string;
  numberId?: string;
  from?: string;
  to?: string;
  message?: string;
  // The docs only document a single `mediaUrl` on the inbound webhook (often
  // null). `mediaUrls` is accepted defensively: the conversations API exposes a
  // plural array, so a future webhook revision may too. `unknown` because the
  // element type is unverified — normalizeMediaUrls validates each entry.
  mediaUrl?: string | null;
  mediaUrls?: unknown;
  direction?: string;
  receivedAt?: string;
  // agent.reaction (iMessage tapbacks)
  reactionType?: string; // love | like | dislike | laugh | emphasize | question
  messageId?: string; // the AGENT-sent message the tapback targets
  messageBody?: string;
  fromNumber?: string;
  createdAt?: string;
}

/**
 * One message object from `GET /v1/conversations/{id}/messages`. Only the fields
 * `resolveRecentInboundMessages` needs; all optional so a partial/renamed payload
 * degrades to "no match" instead of throwing.
 */
interface AgentPhoneConversationMessage {
  id?: string;
  body?: string;
  direction?: string; // "inbound" | "outbound"
  receivedAt?: string;
}

/**
 * Pull the message array out of the conversation-messages response. The exact
 * envelope key is not pinned across AgentPhone versions, so accept a bare array
 * or a wrapper under `items` / `data` / `messages`. Anything else → empty.
 */
function extractConversationMessages(
  json: unknown,
): AgentPhoneConversationMessage[] {
  if (Array.isArray(json)) return json as AgentPhoneConversationMessage[];
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const key of ['items', 'data', 'messages']) {
      const v = obj[key];
      if (Array.isArray(v)) return v as AgentPhoneConversationMessage[];
    }
  }
  return [];
}

/**
 * Extract AgentPhone's REAL message id from the `X-Webhook-ID` delivery id.
 * The delivery id has the shape `del_<messageId>_<numberId>` (verified live), so
 * the message id is the middle segment — a valid `reply_to_message_id` target,
 * available at receipt with no conversation lookup. A `cm…` message id has no
 * underscores, so taking the segment right after `del` is unambiguous. Returns
 * undefined for any other shape so callers fall back to a conversation lookup.
 */
export function extractProviderMessageId(
  webhookId: string | undefined,
): string | undefined {
  if (!webhookId) return undefined;
  const parts = webhookId.split('_');
  if (parts[0] === 'del' && parts.length >= 3 && parts[1]) return parts[1];
  return undefined;
}

export class AgentPhoneTransport implements Transport {
  private readonly apiKey: string | undefined;
  private readonly apiBase: string;
  private readonly agentId: string | undefined;
  private readonly webhookSecret: string | undefined;

  constructor(config: AgentPhoneConfig = {}) {
    this.apiKey = config.apiKey ?? process.env['AGENTPHONE_API_KEY'];
    this.apiBase = (
      config.apiBase ??
      process.env['AGENTPHONE_API_BASE'] ??
      DEFAULT_API_BASE
    ).replace(/\/+$/, '');
    this.agentId = config.agentId ?? process.env['AGENTPHONE_AGENT_ID'];
    this.webhookSecret =
      config.webhookSecret ?? process.env['AGENTPHONE_WEBHOOK_SECRET'];
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.apiKey) {
      throw new Error('AgentPhoneTransport: AGENTPHONE_API_KEY is not set');
    }
    if (!this.agentId) {
      throw new Error('AgentPhoneTransport: AGENTPHONE_AGENT_ID is not set');
    }

    // Verified live against the API + the official AgentPhone client
    // (github.com/AgentPhone-AI/agentphone-mcp `sendMessage`, 2026-06-01):
    //   POST /v1/messages { agent_id, to_number, body, reply_to_message_id? }
    // AgentPhone routes the message into the right conversation purely from
    // agent_id + to_number; `reply_to_message_id` is OPTIONAL and only renders an
    // iMessage inline-reply bubble.
    //
    // SAFETY: `reply_to_message_id` must be a REAL AgentPhone Message.id. A
    // stale/unknown id is rejected with `404 {"detail":"Reply target not found."}`
    // — and that rejects the WHOLE send, which is how every reply once silently
    // failed (the user saw only a read receipt). So we degrade closed: when a
    // reply target is set and the provider 404s "reply target not found", we
    // resend ONCE without it. The message always lands; worst case it is just not
    // threaded. Callers therefore only ever pass real message ids, and even a
    // stale one can never drop the reply.
    const base: Record<string, unknown> = {
      agent_id: this.agentId,
      to_number: msg.to,
      body: msg.text,
    };
    const replyTo = msg.replyToMessageId;

    let res = await this.postMessages(
      replyTo ? { ...base, reply_to_message_id: replyTo } : base,
    );
    let errText = res.ok ? '' : await res.text().catch(() => '');
    if (
      !res.ok &&
      replyTo &&
      res.status === 404 &&
      /reply target not found/i.test(errText)
    ) {
      console.warn(
        '[agentphone] reply target not found; resending without reply_to_message_id',
      );
      res = await this.postMessages(base);
      errText = res.ok ? '' : await res.text().catch(() => '');
    }

    if (!res.ok) {
      throw new Error(
        `AgentPhoneTransport.send failed: ${res.status} ${res.statusText} ${errText}`,
      );
    }

    // Verified live: a 200 returns { id, status, channel, from_number, to_number,
    // reply_to_message_id, reply_parent_unresolved, ... }. The extra id fallbacks
    // are belt-and-suspenders.
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      message_id?: string;
      reply_parent_unresolved?: boolean;
      data?: { id?: string; message_id?: string };
    };
    const id =
      json.id ??
      json.message_id ??
      json.data?.id ??
      json.data?.message_id ??
      '';
    const result: SendResult = { id };
    if (json.reply_parent_unresolved === true) {
      // The message DID send — it just wasn't threaded. Surface for observability;
      // never retry on this (the 404 path above is the only reply-target retry).
      console.warn(
        '[agentphone] reply_parent_unresolved: message delivered un-threaded',
      );
      result.replyParentUnresolved = true;
    }
    return result;
  }

  /** POST a prepared body to /v1/messages. Caller owns response handling so the
   *  reply-target 404 retry can reuse one code path. */
  private async postMessages(
    body: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(`${this.apiBase}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey as string}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * List recent INBOUND messages of a conversation, NEWEST FIRST, each with its
   * real AgentPhone Message.id — so a reply can thread under any one of them.
   * Inbound webhooks carry no message id, so we read them from the conversation.
   *
   * Best-effort and fail-open: any non-200, shape mismatch, or network/timeout
   * error → `[]` (caller sends un-threaded). Bounded by AbortSignal so a slow
   * endpoint can't stall the turn it runs inside.
   */
  async resolveRecentInboundMessages(
    conversationId: string,
    limit: number = CONVERSATION_LOOKUP_LIMIT,
  ): Promise<ReplyTargetMessage[]> {
    if (!this.apiKey || !conversationId) return [];

    try {
      const url =
        `${this.apiBase}/v1/conversations/${encodeURIComponent(conversationId)}` +
        `/messages?limit=${limit}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        // Bound the lookup so a slow/black-holed endpoint can't stall the turn.
        signal: AbortSignal.timeout(CONVERSATION_LOOKUP_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const json: unknown = await res.json().catch(() => undefined);

      const inbound: ReplyTargetMessage[] = [];
      for (const m of extractConversationMessages(json)) {
        if (m.direction !== 'inbound') continue;
        if (typeof m.id !== 'string' || m.id.length === 0) continue;
        inbound.push({
          id: m.id,
          text: typeof m.body === 'string' ? m.body : '',
          receivedAt: typeof m.receivedAt === 'string' ? m.receivedAt : undefined,
        });
      }
      // Newest first so the freshest message is the default reply target. ISO-8601
      // sorts lexicographically; a missing receivedAt ('') sorts oldest.
      inbound.sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));
      return inbound;
    } catch (err) {
      console.error('[agentphone] resolveRecentInboundMessages failed', err);
      return [];
    }
  }

  /**
   * HMAC-SHA256 verification over RAW body bytes, constant-time compare, with
   * replay protection. HARD-FAILS (returns false) when misconfigured or stale.
   *
   * Replay defense (fail-CLOSED):
   *   - If a `timestamp` is provided, it MUST be a numeric epoch within
   *     ±WEBHOOK_MAX_SKEW_SECONDS of now, AND the signature MUST match the
   *     timestamp-bound HMAC over `${timestamp}.${rawBody}`. A timestamp that is
   *     missing/non-numeric FOR THIS variant -> reject. This binds the
   *     signature to a moment in time so a captured request can't be replayed.
   *   - The body-only HMAC fallback is accepted ONLY when no timestamp is
   *     supplied (providers that don't sign a timestamp), and is gated behind
   *     the /* VERIFY against live API *\/ note until the live format is pinned.
   */
  verifyWebhook(
    rawBody: Buffer | string,
    signature: string,
    timestamp: string,
  ): boolean {
    // Fail-closed: never no-op to true when misconfigured.
    if (!this.webhookSecret || this.webhookSecret.length === 0) {
      throw new Error(
        'AgentPhoneTransport.verifyWebhook: AGENTPHONE_WEBHOOK_SECRET is not set (refusing to verify — fail closed)',
      );
    }
    if (typeof signature !== 'string' || signature.length === 0) {
      return false;
    }

    const rawBytes = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(rawBody, 'utf8');

    const hmac = (signedPayload: Buffer): string =>
      createHmac('sha256', this.webhookSecret as string)
        .update(signedPayload)
        .digest('hex');

    // Normalize an incoming signature like "sha256=<hex>".
    const provided = signature.includes('=')
      ? (signature.split('=', 2)[1] ?? '')
      : signature;

    // AgentPhone always signs `${timestamp}.${rawBody}` and sends the epoch in
    // X-Webhook-Timestamp. A missing/empty timestamp means we cannot bind the
    // signature to a moment in time, so we FAIL CLOSED. There is deliberately no
    // body-only path: it would accept captured signatures forever (no replay
    // window) on the one boundary an attacker could use to drive a coding agent.
    if (typeof timestamp !== 'string' || timestamp.length === 0) {
      return false;
    }
    // Fail-closed if the timestamp isn't a usable numeric epoch.
    const tsSeconds = Number(timestamp);
    if (!Number.isFinite(tsSeconds)) return false;
    // Reject stale/future signatures (replay window).
    const nowSeconds = Date.now() / 1000;
    if (Math.abs(nowSeconds - tsSeconds) > WEBHOOK_MAX_SKEW_SECONDS) {
      return false;
    }
    const tsPrefix = Buffer.from(`${timestamp}.`, 'utf8');
    const expected = hmac(Buffer.concat([tsPrefix, rawBytes]));
    return constantTimeEquals(provided, expected);
  }

  /**
   * Map a verified AgentPhone webhook body into the normalized InboundMessage,
   * or `null` when the event is not an actionable message/reaction (the caller
   * should then no-op with a 200, not orchestrate).
   *
   * `webhookId` is the value of the `X-Webhook-ID` header (`del_<messageId>_<numberId>`).
   * Stable across the provider's retries → the idempotency / dedup key. The real
   * message id is its embedded middle segment — parsed into `providerMessageId` so a
   * reply can thread under THIS message without a conversation lookup.
   */
  parseInbound(
    rawBody: Buffer | string,
    webhookId?: string,
  ): InboundMessage | null {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const parsed: unknown = JSON.parse(text);
    // JSON.parse accepts primitives/arrays ("null", "42", "[]", '"x"') without
    // throwing. Reject anything that isn't a plain object so the caller 400s
    // instead of building a degenerate, empty InboundMessage.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'AgentPhoneTransport.parseInbound: webhook body is not a JSON object',
      );
    }
    const env = parsed as AgentPhoneWebhookEnvelope;

    const eventType = env.event ?? TransportEvent.AGENT_MESSAGE;
    const isReaction = eventType === TransportEvent.AGENT_REACTION;
    const isMessage = eventType === TransportEvent.AGENT_MESSAGE;
    // Only message + reaction events produce an actionable inbound. Other events
    // (e.g. `agent.call_ended`) carry no user text; returning null lets the
    // caller acknowledge with a 200 instead of orchestrating an empty message.
    if (!isReaction && !isMessage) {
      return null;
    }
    const data = env.data ?? {};

    // Channel is TOP-LEVEL (not under data). Map the known values; anything
    // unrecognized falls back to iMessage, the primary channel.
    const channel: MessageChannel =
      env.channel === MessageChannel.SMS
        ? MessageChannel.SMS
        : env.channel === MessageChannel.MMS
          ? MessageChannel.MMS
          : env.channel === MessageChannel.VOICE
            ? MessageChannel.VOICE
            : MessageChannel.IMESSAGE;

    const inbound: InboundMessage = {
      // Reactions carry the sender under `fromNumber`; messages under `from`.
      from: isReaction ? (data.fromNumber ?? '') : (data.from ?? ''),
      // For a reaction the meaningful text is the reaction type (e.g. "like");
      // for a message it's the body.
      text: isReaction ? (data.reactionType ?? '') : (data.message ?? ''),
      channel,
      messageId: webhookId ?? '',
    };

    // The real message id is embedded in the X-Webhook-ID (`del_<messageId>_…`),
    // so a reply can thread under THIS message with no conversation lookup/race.
    const providerMessageId = extractProviderMessageId(webhookId);
    if (providerMessageId !== undefined) {
      inbound.providerMessageId = providerMessageId;
    }

    if (data.conversationId !== undefined) {
      inbound.conversationId = data.conversationId;
    }
    if (env.conversationState !== undefined) {
      inbound.conversationState = env.conversationState;
    }
    if (env.recentHistory !== undefined) {
      inbound.recentHistory = env.recentHistory;
    }
    // A reaction binds to the exact agent message it targets (`data.messageId`).
    // This is the deterministic handle the safety gate uses to bind a tapback to
    // a specific pending prompt. NOTE: this is the ONLY inbound reply linkage
    // AgentPhone forwards — a typed inline reply (the iMessage "Reply" thread)
    // arrives as a plain agent.message with no target field (verified live
    // against the conversations API 2026-06-02), so there is nothing to map for
    // it and it can never bind to a specific message.
    if (isReaction && data.messageId !== undefined) {
      inbound.reactionTo = data.messageId;
    }
    // Surface image attachments (MMS / iMessage photos) so the orchestrator can
    // feed them to a vision model. Only messages carry media; a reaction never
    // does. Both the documented singular `mediaUrl` and a defensive plural
    // `mediaUrls` are normalized into one deduped list; absent → field omitted.
    if (isMessage) {
      const mediaUrls = normalizeMediaUrls(data.mediaUrl, data.mediaUrls);
      if (mediaUrls.length > 0) inbound.mediaUrls = mediaUrls;
    }

    return inbound;
  }
}

/**
 * Normalize AgentPhone's media fields into a deduped list of attachment URLs.
 * Accepts the documented singular `mediaUrl` (string | null) plus a defensive
 * plural `mediaUrls` (unknown — each element validated). Non-string/blank entries
 * are dropped; order is singular-first then plural, first occurrence wins.
 */
function normalizeMediaUrls(
  single: string | null | undefined,
  plural: unknown,
): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v !== 'string') return;
    const url = v.trim();
    if (url.length > 0 && !out.includes(url)) out.push(url);
  };
  add(single);
  if (Array.isArray(plural)) for (const v of plural) add(v);
  return out;
}

/**
 * Constant-time string compare via crypto.timingSafeEqual. Returns false on
 * length mismatch (without leaking via early return timing on the bytes).
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still do a comparison against a same-length buffer to avoid trivially
    // short-circuiting, then return false.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
