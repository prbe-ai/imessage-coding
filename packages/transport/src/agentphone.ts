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
import type { SendResult, Transport } from './transport.ts';

const DEFAULT_API_BASE = 'https://api.agentphone.ai';

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
  mediaUrl?: string | null;
  direction?: string;
  receivedAt?: string;
  // agent.reaction (iMessage tapbacks)
  reactionType?: string; // love | like | dislike | laugh | emphasize | question
  messageId?: string; // the AGENT-sent message the tapback targets
  messageBody?: string;
  fromNumber?: string;
  createdAt?: string;
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
    //   POST /v1/messages { agent_id, to_number, body, media_url?, number_id? }
    // AgentPhone threads the reply into the right conversation purely from
    // agent_id + to_number, so a reply target is NOT required.
    //
    // We deliberately do NOT forward msg.replyToMessageId here. AgentPhone's
    // optional `reply_to_message_id` must be a real *message* id; an inbound
    // webhook gives us only the per-delivery `X-Webhook-ID` (what populates
    // InboundMessage.messageId), never a message id. Passing that delivery id
    // makes AgentPhone fail to resolve the parent and reject the whole send with
    // `404 {"detail":"Reply target not found."}` — so every reply silently
    // failed while the user saw only a read receipt. Omitting it sends cleanly.
    const url = `${this.apiBase}/v1/messages`;
    const body: Record<string, unknown> = {
      agent_id: this.agentId,
      to_number: msg.to,
      body: msg.text,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `AgentPhoneTransport.send failed: ${res.status} ${res.statusText} ${detail}`,
      );
    }

    // Verified live: a 200 returns { id, status, channel, from_number,
    // to_number, ... }. The extra fallbacks are belt-and-suspenders.
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      message_id?: string;
      data?: { id?: string; message_id?: string };
    };
    const id =
      json.id ??
      json.message_id ??
      json.data?.id ??
      json.data?.message_id ??
      '';
    return { id };
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
   * `webhookId` is the value of the `X-Webhook-ID` header. AgentPhone gives
   * inbound messages no body-level id, so this per-delivery id is our stable
   * per-message handle. It is stable across the provider's retries, so it is the
   * natural idempotency key — though nothing dedupes on it yet (see callers).
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

    return inbound;
  }
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
