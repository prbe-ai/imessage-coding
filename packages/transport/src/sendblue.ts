/**
 * @imsg/transport — Sendblue concrete implementation of the Transport port.
 *
 * Env contract:
 *   SENDBLUE_API_KEY_ID      (required for send — `sb-api-key-id` header)
 *   SENDBLUE_API_SECRET      (required for send — `sb-api-secret-key` header)
 *   SENDBLUE_FROM_NUMBER     (optional — the Sendblue sending number, E.164)
 *   SENDBLUE_API_BASE        (default https://api.sendblue.com)
 *   SENDBLUE_WEBHOOK_SECRET  (required for verifyWebhook — HARD FAIL if absent)
 *
 * SECURITY: Sendblue does NOT HMAC-sign inbound webhooks (verified against
 * docs.sendblue.com 2026-06-30 — it only echoes a configured `secret` back in an
 * UNDOCUMENTED header, with no body-integrity signature and no replay window).
 * So we authenticate the webhook with a high-entropy shared secret embedded in
 * the webhook URL PATH: the ingress route extracts that path token and hands it
 * to verifyWebhook(), which constant-time compares it to SENDBLUE_WEBHOOK_SECRET
 * and HARD-FAILS when the secret is unset. This is weaker than AgentPhone's
 * body-bound HMAC, but solid over HTTPS for this use, and the deterministic
 * safety gate never trusts the LLM for destructive actions regardless.
 *
 * CAPABILITY GAPS vs AgentPhone (intentional — see provider eval):
 *   - No inbound tapbacks: Sendblue delivers no webhook for a user's reaction,
 *     so `reactionTo` is never set and approvals are answered by a typed reply.
 *   - No reply threading: /api/send-message has no reply_to param, so an
 *     outbound `replyToMessageId` cannot thread (surfaced via replyParentUnresolved).
 *   - `react`, `typing`, and `resolveRecentInboundMessages` are intentionally
 *     NOT implemented (all optional on the Transport port).
 */
import { timingSafeEqual } from 'node:crypto';
import {
  MessageChannel,
  type InboundMessage,
  type OutboundMessage,
} from '@imsg/shared';
import type { SendResult, Transport } from './transport.ts';

/** Sendblue API origin used when `SENDBLUE_API_BASE` is unset. */
export const SENDBLUE_DEFAULT_API_BASE = 'https://api.sendblue.com';

/** Auth headers Sendblue expects on the send call (you → Sendblue). */
const SENDBLUE_KEY_ID_HEADER = 'sb-api-key-id';
const SENDBLUE_KEY_SECRET_HEADER = 'sb-api-secret-key';

/** Value of the inbound `service` field when the message arrived over SMS
 *  (vs "iMessage"). A provider wire constant — not our MessageChannel enum. */
const SENDBLUE_SERVICE_SMS = 'SMS';

export interface SendblueConfig {
  apiKeyId?: string;
  apiSecret?: string;
  fromNumber?: string;
  apiBase?: string;
  webhookSecret?: string;
}

/**
 * Inbound "receive" webhook payload
 * (docs.sendblue.com/getting-started/receiving-messages, verified 2026-06-30).
 * Every field optional so a partial/renamed payload degrades to "not actionable"
 * (parseInbound returns null) instead of throwing.
 */
interface SendblueInboundPayload {
  content?: string;
  is_outbound?: boolean;
  status?: string;
  /** Apple GUID — stable per-message handle; lives in the BODY (not a header). */
  message_handle?: string;
  /** E.164 of the end user who texted us (the sender). */
  from_number?: string;
  to_number?: string;
  media_url?: string;
  message_type?: string;
  /** Group/conversation key; empty string for a 1:1 chat. */
  group_id?: string;
  /** "iMessage" | "SMS". */
  service?: string;
}

export class SendblueTransport implements Transport {
  private readonly apiKeyId: string | undefined;
  private readonly apiSecret: string | undefined;
  private readonly fromNumber: string | undefined;
  private readonly apiBase: string;
  private readonly webhookSecret: string | undefined;

  constructor(config: SendblueConfig = {}) {
    this.apiKeyId = config.apiKeyId ?? process.env['SENDBLUE_API_KEY_ID'];
    this.apiSecret = config.apiSecret ?? process.env['SENDBLUE_API_SECRET'];
    this.fromNumber = config.fromNumber ?? process.env['SENDBLUE_FROM_NUMBER'];
    this.apiBase = (
      config.apiBase ??
      process.env['SENDBLUE_API_BASE'] ??
      SENDBLUE_DEFAULT_API_BASE
    ).replace(/\/+$/, '');
    this.webhookSecret =
      config.webhookSecret ?? process.env['SENDBLUE_WEBHOOK_SECRET'];
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.apiKeyId || !this.apiSecret) {
      throw new Error(
        'SendblueTransport: SENDBLUE_API_KEY_ID / SENDBLUE_API_SECRET is not set',
      );
    }

    // docs.sendblue.com/getting-started/sending-messages:
    //   POST /api/send-message { number, from_number?, content, media_url? }
    // There is NO reply_to param, so an outbound reply target cannot thread.
    const body: Record<string, unknown> = {
      number: msg.to,
      content: msg.text,
    };
    if (this.fromNumber) body['from_number'] = this.fromNumber;

    const res = await fetch(`${this.apiBase}/api/send-message`, {
      method: 'POST',
      headers: {
        [SENDBLUE_KEY_ID_HEADER]: this.apiKeyId,
        [SENDBLUE_KEY_SECRET_HEADER]: this.apiSecret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `SendblueTransport.send failed: ${res.status} ${res.statusText} ${errText}`,
      );
    }

    // A 200 returns { message_handle, status, ... }. message_handle is the id.
    const json = (await res.json().catch(() => ({}))) as {
      message_handle?: string;
      status?: string;
    };
    const result: SendResult = { id: json.message_handle ?? '' };
    // Sendblue can't inline-reply, so a requested reply target is dropped. The
    // message still sends; surface the un-threading for observability only.
    if (msg.replyToMessageId) {
      result.replyParentUnresolved = true;
    }
    return result;
  }

  /**
   * Verify an inbound Sendblue webhook. Sendblue does NOT HMAC-sign the body, so
   * `signature` here is the high-entropy secret token the ingress route extracted
   * from the webhook URL path. We constant-time compare it to the configured
   * SENDBLUE_WEBHOOK_SECRET and HARD-FAIL (throw) when that secret is unset.
   * `timestamp` is unused (Sendblue signs no timestamp).
   */
  verifyWebhook(
    _rawBody: Buffer | string,
    signature: string,
    _timestamp: string,
  ): boolean {
    // Fail-closed: never no-op to true when misconfigured.
    if (!this.webhookSecret || this.webhookSecret.length === 0) {
      throw new Error(
        'SendblueTransport.verifyWebhook: SENDBLUE_WEBHOOK_SECRET is not set (refusing to verify — fail closed)',
      );
    }
    if (typeof signature !== 'string' || signature.length === 0) {
      return false;
    }
    return constantTimeEquals(signature, this.webhookSecret);
  }

  /**
   * Map a verified Sendblue webhook body into the normalized InboundMessage, or
   * `null` when the delivery is not an actionable user message (an outbound
   * status echo, or a payload with no sender/content) — the caller then acks
   * with a 200 instead of orchestrating an empty turn.
   *
   * `webhookId` is unused: Sendblue's stable per-delivery id (`message_handle`)
   * lives in the BODY, so it is read here and surfaced as `messageId`.
   */
  parseInbound(
    rawBody: Buffer | string,
    _webhookId?: string,
  ): InboundMessage | null {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const parsed: unknown = JSON.parse(text);
    // JSON.parse accepts primitives/arrays ("null", "42", "[]", '"x"') without
    // throwing. Reject anything that isn't a plain object so the caller 400s
    // instead of building a degenerate, empty InboundMessage.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'SendblueTransport.parseInbound: webhook body is not a JSON object',
      );
    }
    const p = parsed as SendblueInboundPayload;

    // Sendblue posts to the same webhook for our own outbound status callbacks;
    // only an INBOUND user message is actionable. Drop outbound echoes.
    if (p.is_outbound === true) return null;

    // The sender (and account routing key) is `from_number`. No sender → not an
    // actionable inbound message (e.g. a bare status delivery).
    const from = typeof p.from_number === 'string' ? p.from_number : '';
    if (from.length === 0) return null;

    const content = typeof p.content === 'string' ? p.content : '';
    const media = typeof p.media_url === 'string' ? p.media_url.trim() : '';
    // A message with neither text nor media carries nothing to act on.
    if (content.length === 0 && media.length === 0) return null;

    const channel: MessageChannel =
      p.service === SENDBLUE_SERVICE_SMS
        ? MessageChannel.SMS
        : MessageChannel.IMESSAGE;

    const inbound: InboundMessage = {
      from,
      text: content,
      channel,
      // Sendblue's per-message handle (an Apple GUID) is the stable dedup key.
      messageId: typeof p.message_handle === 'string' ? p.message_handle : '',
    };
    // group_id is '' for 1:1 chats; only set a conversation id when present.
    if (typeof p.group_id === 'string' && p.group_id.length > 0) {
      inbound.conversationId = p.group_id;
    }
    if (media.length > 0) {
      inbound.mediaUrls = [media];
    }
    return inbound;
  }
}

/**
 * Constant-time string compare via crypto.timingSafeEqual. Returns false on
 * length mismatch (without leaking via early-return timing on the bytes).
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still compare against a same-length buffer so we don't trivially
    // short-circuit on length, then return false.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
