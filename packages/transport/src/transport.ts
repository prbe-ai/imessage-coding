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
   * Resolve the provider's real message id for an inbound user message so an
   * outbound reply can thread under it (`OutboundMessage.replyToMessageId`).
   * Inbound webhooks carry no body-level message id, so this looks the message
   * up by conversation. Optional capability.
   *
   * Returns the id ONLY on an exact `matchBody` match — threading under the wrong
   * message is worse than not threading, so an ambiguous/absent match (and ANY
   * error) resolves to `undefined`. MUST be best-effort and never throw.
   */
  resolveInboundMessageId?(
    conversationId: string,
    opts?: { matchBody?: string },
  ): Promise<string | undefined>;
}
