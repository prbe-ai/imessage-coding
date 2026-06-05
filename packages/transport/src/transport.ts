/**
 * @imsg/transport — the Transport PORT.
 *
 * A swappable messaging boundary. The control plane depends ONLY on this
 * interface; the concrete provider (AgentPhone today, something else tomorrow)
 * lives behind it. Keep provider-specific field names out of this file.
 */
import type { InboundMessage, OutboundMessage } from '@imsg/shared';

export interface SendResult {
  /** Provider message id of the sent message. */
  id: string;
  /**
   * The provider could not resolve the `replyToMessageId` parent, so the message
   * was delivered WITHOUT an inline-reply thread. Observability only — the
   * message already sent, so this is never a retry trigger.
   */
  replyParentUnresolved?: boolean;
}

/** One recent inbound (user) message, with its real provider id — a valid
 *  `OutboundMessage.replyToMessageId` target. Returned by the conversation lookup
 *  so a reply can thread under ANY recent message, not just the latest. */
export interface ReplyTargetMessage {
  /** Real provider Message.id (a valid reply target). */
  id: string;
  /** The message body — lets a caller present it for the model to choose. */
  text: string;
  /** Provider receivedAt (ISO-8601), when available; newest first by this. */
  receivedAt?: string;
}

export interface Transport {
  /** Send an outbound message. Returns the provider message id. */
  send(msg: OutboundMessage): Promise<SendResult>;

  /**
   * React to a prior message (tapback), if the provider supports it.
   * Optional capability.
   */
  react?(to: string, replyToMessageId: string, emoji: string): Promise<void>;

  /** Send a typing indicator to a recipient, if supported. Optional. */
  typing?(to: string): Promise<void>;

  /**
   * Verify an inbound webhook is authentic.
   *
   * MUST compute the signature over the RAW request body bytes, MUST use a
   * constant-time comparison, and MUST hard-fail (return false / throw) if the
   * configured secret is missing — never silently no-op to `true`.
   */
  verifyWebhook(
    rawBody: Buffer | string,
    signature: string,
    timestamp: string,
  ): boolean;

  /**
   * Map a raw verified webhook body into the normalized InboundMessage, or
   * `null` when the delivery is not an actionable message (e.g. a call-ended or
   * other non-message event) and the caller should simply acknowledge it.
   *
   * `webhookId` is the provider's per-delivery id (AgentPhone's `X-Webhook-ID`
   * header) — the stable per-message handle used as `messageId`.
   */
  parseInbound(
    rawBody: Buffer | string,
    webhookId?: string,
  ): InboundMessage | null;

  /**
   * List recent INBOUND (user) messages in a conversation, NEWEST FIRST, each
   * with its real provider Message.id — so an outbound reply can thread under ANY
   * of them (`OutboundMessage.replyToMessageId`), not just the latest. Inbound
   * webhooks carry no body-level message id, so this reads them from the
   * conversation. Optional capability.
   *
   * MUST be best-effort and never throw: any non-200 / shape mismatch / network
   * error resolves to `[]` (caller then sends un-threaded).
   */
  resolveRecentInboundMessages?(
    conversationId: string,
    limit?: number,
  ): Promise<ReplyTargetMessage[]>;
}
