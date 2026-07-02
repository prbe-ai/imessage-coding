/**
 * POST /api/sendblue/webhook/:token — inbound Sendblue message ingress.
 *
 * Mirrors the AgentPhone ingress (verify → parse → dedup → fast-ack + detached
 * orchestrate; see routes/webhook.ts for the FAST-ACK rationale) with two
 * provider differences:
 *
 *   - AUTH: Sendblue does NOT HMAC-sign webhooks, so the `:token` path segment
 *     is a high-entropy shared secret, constant-time compared to
 *     SENDBLUE_WEBHOOK_SECRET by the transport (fail-closed if unset). Register
 *     the webhook URL with the secret embedded:
 *       `${WEBHOOK_BASE_URL}/api/sendblue/webhook/<SENDBLUE_WEBHOOK_SECRET>`
 *
 *   - DEDUP: Sendblue's stable per-delivery id (`message_handle`) lives in the
 *     BODY, not a header, so we dedup on the parsed `inbound.messageId` (which
 *     parseInbound populates from `message_handle`) rather than a header id.
 *
 * We ALWAYS return a 2xx once the signature is valid (even on a no-op) so
 * Sendblue does not retry-storm (a non-2xx makes it redeliver; a 410 would make
 * it delete the webhook).
 */
import { Hono } from 'hono';
import { orchestrate } from '../orchestrator/index.ts';
import { claimWebhook, releaseWebhook } from '../db/repo.ts';
import { getTransport } from '../transport.ts';

export const webhookSendblueRoute = new Hono();

webhookSendblueRoute.post('/api/sendblue/webhook/:token', async (c) => {
  const transport = getTransport();

  // RAW bytes — parseInbound reads the body; verify does not depend on it.
  const rawBody = Buffer.from(await c.req.arrayBuffer());
  const token = c.req.param('token') ?? '';

  // Sendblue signs no body HMAC; the URL token is the shared secret.
  // verifyWebhook THROWS (fail-closed) if SENDBLUE_WEBHOOK_SECRET is unset.
  let valid: boolean;
  try {
    valid = transport.verifyWebhook(rawBody, token, '');
  } catch (err) {
    console.error('[sendblue-webhook] verify misconfigured', err);
    return c.json({ error: 'webhook_not_configured' }, 500);
  }
  if (!valid) {
    return c.json({ error: 'invalid_signature' }, 401);
  }

  let inbound;
  try {
    inbound = transport.parseInbound(rawBody);
  } catch (err) {
    console.error('[sendblue-webhook] parse failed', err);
    return c.json({ error: 'unparseable_body' }, 400);
  }

  // Non-actionable delivery (our own outbound status echo, or a payload with no
  // sender/content) — ack without orchestrating an empty turn. Claimed AFTER
  // this so a non-actionable delivery never burns a dedup id.
  if (inbound === null) {
    return c.json({ ok: true, handled: false });
  }

  // DEDUP on the body's `message_handle` (Sendblue redelivers until it gets a
  // 2xx). A losing claim is a redelivery of a message we already handled — ack
  // and stop, no second turn, no duplicate reply.
  const dedupId = inbound.messageId;
  if (dedupId) {
    let claimed: boolean;
    try {
      claimed = await claimWebhook(dedupId);
    } catch (err) {
      // Ledger unreachable: fail OPEN (process) rather than drop the message.
      console.error(
        '[sendblue-webhook] dedup claim failed; processing anyway',
        err,
      );
      claimed = true;
    }
    if (!claimed) {
      return c.json({ ok: true, handled: false, duplicate: true });
    }
  } else {
    console.warn(
      '[sendblue-webhook] missing message_handle; cannot dedup this delivery',
    );
  }

  // FAST ACK — fire-and-forget the turn (see routes/webhook.ts header). A
  // REJECTION is a prologue blip that did no work, so we RELEASE the tentative
  // claim to let Sendblue's redelivery re-run instead of deduping it into a
  // silent drop.
  void orchestrate(inbound, transport).catch(async (err) => {
    console.error(
      '[sendblue-webhook] orchestrate threw (background); releasing claim for retry',
      err,
    );
    if (dedupId) {
      await releaseWebhook(dedupId).catch((relErr) => {
        console.error(
          '[sendblue-webhook] failed to release claim after turn error',
          relErr,
        );
      });
    }
  });
  return c.json({ ok: true, accepted: true });
});
