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
} from '@imsg/shared';
import type { SendResult, Transport } from './transport.ts';

const DEFAULT_API_BASE = 'https://api.agentphone.ai';

/**
 * Max allowed clock skew (seconds) between the signed webhook timestamp and now.
 * A signature older/newer than this is rejected as a replay. 5 minutes mirrors
 * the common provider convention (Stripe/Svix use the same window).
 */
const WEBHOOK_MAX_SKEW_SECONDS = 300;

/** Header AgentPhone sends the HMAC signature in. */ /* VERIFY against live API */
export const AGENTPHONE_SIGNATURE_HEADER = 'x-agentphone-signature';
/** Header AgentPhone sends the signed timestamp in. */ /* VERIFY against live API */
export const AGENTPHONE_TIMESTAMP_HEADER = 'x-agentphone-timestamp';

export interface AgentPhoneConfig {
  apiKey?: string;
  apiBase?: string;
  agentId?: string;
  webhookSecret?: string;
}

/**
 * Raw AgentPhone webhook envelope. /* VERIFY against live API *\/
 * Shape inferred from docs: a typed event wrapping a message payload.
 */
interface AgentPhoneWebhookEnvelope {
  /* VERIFY against live API */ type?: string; // e.g. "agent.message" | "agent.reaction"
  /* VERIFY against live API */ event?: string; // some providers use `event` not `type`
  data?: AgentPhoneMessagePayload;
  message?: AgentPhoneMessagePayload; // alt nesting
}

interface AgentPhoneMessagePayload {
  /* VERIFY against live API */ id?: string;
  /* VERIFY against live API */ message_id?: string;
  /* VERIFY against live API */ from_number?: string;
  /* VERIFY against live API */ from?: string;
  /* VERIFY against live API */ body?: string;
  /* VERIFY against live API */ text?: string;
  /* VERIFY against live API */ channel?: string; // "imessage" | "sms"
  /* VERIFY against live API */ conversation_state?: string;
  /* VERIFY against live API */ recent_history?: string;
  /* VERIFY against live API */ reply_to_message_id?: string;
  /* VERIFY against live API */ reaction_to?: string; // for tapbacks
  /* VERIFY against live API */ reaction?: string; // tapback emoji/value
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

    /* VERIFY against live API: endpoint, body field names, response shape. */
    const url = `${this.apiBase}/v1/messages`;
    const body: Record<string, unknown> = {
      agent_id: this.agentId,
      to_number: msg.to,
      body: msg.text,
    };
    if (msg.replyToMessageId !== undefined) {
      body['reply_to_message_id'] = msg.replyToMessageId;
    }

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

    /* VERIFY against live API: response id field. */
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

    const hasTimestamp = typeof timestamp === 'string' && timestamp.length > 0;

    if (hasTimestamp) {
      // TIMESTAMP-BOUND variant is REQUIRED once a timestamp is present.
      // Fail-closed if it isn't a usable numeric epoch.
      const tsSeconds = Number(timestamp);
      if (!Number.isFinite(tsSeconds)) return false;
      // Reject stale/future signatures (replay window).
      const nowSeconds = Date.now() / 1000;
      if (Math.abs(nowSeconds - tsSeconds) > WEBHOOK_MAX_SKEW_SECONDS) {
        return false;
      }
      const tsPrefix = Buffer.from(`${timestamp}.`, 'utf8');
      const withTimestamp = hmac(Buffer.concat([tsPrefix, rawBytes]));
      return constantTimeEquals(provided, withTimestamp);
    }

    /* VERIFY against live API: signed payload format. When the provider sends NO
       timestamp header, fall back to the body-only HMAC. This fallback carries
       no replay protection, so it stays behind this note until the live signing
       format (and whether a timestamp is always present) is confirmed. */
    const bodyOnly = hmac(rawBytes);
    return constantTimeEquals(provided, bodyOnly);
  }

  parseInbound(rawBody: Buffer | string): InboundMessage {
    const text = Buffer.isBuffer(rawBody)
      ? rawBody.toString('utf8')
      : rawBody;
    const env = JSON.parse(text) as AgentPhoneWebhookEnvelope;

    /* VERIFY against live API: where the event type lives. */
    const eventType = env.type ?? env.event ?? TransportEvent.AGENT_MESSAGE;
    const payload: AgentPhoneMessagePayload = env.data ?? env.message ?? {};

    const isReaction = eventType === TransportEvent.AGENT_REACTION;

    /* VERIFY against live API: which channel string the provider sends. */
    const channel =
      payload.channel === MessageChannel.SMS
        ? MessageChannel.SMS
        : MessageChannel.IMESSAGE;

    const inbound: InboundMessage = {
      from: payload.from_number ?? payload.from ?? '',
      // For a reaction, the meaningful text is the reaction value (e.g. a
      // tapback emoji); for a message it's the body.
      text: isReaction
        ? (payload.reaction ?? payload.body ?? payload.text ?? '')
        : (payload.body ?? payload.text ?? ''),
      channel,
      messageId: payload.id ?? payload.message_id ?? '',
    };

    if (payload.conversation_state !== undefined) {
      inbound.conversationState = payload.conversation_state;
    }
    if (payload.recent_history !== undefined) {
      inbound.recentHistory = payload.recent_history;
    }
    // A reaction points at the message it reacts to; a normal reply may carry
    // reply_to_message_id which we also surface as reactionTo's sibling.
    const reactionTarget = isReaction
      ? (payload.reaction_to ?? payload.reply_to_message_id)
      : payload.reply_to_message_id;
    if (reactionTarget !== undefined) {
      inbound.reactionTo = reactionTarget;
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
