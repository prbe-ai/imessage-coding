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
}
