/**
 * POST /api/agentphone/webhook — inbound message ingress.
 *
 * 1. Read the RAW request body (bytes) — HMAC must be computed over exactly
 *    what the provider signed, so we never re-serialize.
 * 2. Verify the signature via the Transport (HMAC-SHA256, constant-time,
 *    hard-fails if the secret is unset). A bad/absent signature -> 401.
 * 3. parseInbound -> normalized InboundMessage (404/no-op for non-actionable).
 * 4. DEDUP: claim the delivery by its stable X-Webhook-ID. AgentPhone delivers
 *    at-least-once (a slow ack, an outage, or a webhook timeout makes it retry
 *    the SAME message), so without this every redelivery re-ran orchestrate and
 *    the user got the same reply 2-5x. A losing claim -> ack 200 and stop.
 * 5. orchestrator turn (FIRE-AND-FORGET, see below).
 *
 * FAST ACK: we kick off orchestrate but DO NOT await it before returning 200.
 * The assistant turn is a multi-round tool-calling loop that can outlast the
 * provider's webhook timeout; awaiting it inline was what made AgentPhone treat
 * a still-running turn as a failed delivery and retry. Acking in <100ms removes
 * that trigger, and the dedup ledger absorbs any genuine post-ack redelivery.
 * The turn runs on Bun's event loop after the response (Bun does not kill a
 * detached promise the way a Worker would) and is fail-closed internally
 * (runUserTurn catches and sends a safe clarify, so a "handled" turn always
 * resolves; only a prologue blip — account resolution, the first logMessage —
 * rejects). TENTATIVE CLAIM: the claim is recorded before the turn, but if the
 * turn REJECTS we RELEASE it (releaseWebhook) so the provider's redelivery can
 * re-run rather than be deduped into a silent drop. TRADEOFF: a hard process
 * kill mid-turn (e.g. a deploy) skips the release and drops that one message —
 * an accepted at-most-once cost, far better than the duplicate storm.
 *
 * We ALWAYS return 200 once the signature is valid (even on a no-op) so the
 * provider does not retry-storm.
 */
import { Hono } from 'hono';
import {
  AGENTPHONE_SIGNATURE_HEADER,
  AGENTPHONE_TIMESTAMP_HEADER,
  AGENTPHONE_WEBHOOK_ID_HEADER,
} from '@imsg/transport';
import { orchestrate } from '../orchestrator/index.ts';
import { claimWebhook, releaseWebhook } from '../db/repo.ts';
import { getTransport } from '../transport.ts';

export const webhookRoute = new Hono();

webhookRoute.post('/api/agentphone/webhook', async (c) => {
  const transport = getTransport();

  // RAW bytes — do not parse before verifying.
  const rawBody = Buffer.from(await c.req.arrayBuffer());

  const signature =
    c.req.header(AGENTPHONE_SIGNATURE_HEADER) ??
    c.req.header(AGENTPHONE_SIGNATURE_HEADER.toLowerCase()) ??
    '';
  const timestamp =
    c.req.header(AGENTPHONE_TIMESTAMP_HEADER) ??
    c.req.header(AGENTPHONE_TIMESTAMP_HEADER.toLowerCase()) ??
    '';
  // Per-delivery id (X-Webhook-ID) — the stable per-message handle. Used both as
  // the dedup key (step 3 below) and, inside parseInbound, as messageId.
  const webhookId =
    c.req.header(AGENTPHONE_WEBHOOK_ID_HEADER) ??
    c.req.header(AGENTPHONE_WEBHOOK_ID_HEADER.toLowerCase()) ??
    '';

  // verifyWebhook THROWS (fail-closed) if the secret is unconfigured.
  let valid: boolean;
  try {
    valid = transport.verifyWebhook(rawBody, signature, timestamp);
  } catch (err) {
    console.error('[webhook] verify misconfigured', err);
    return c.json({ error: 'webhook_not_configured' }, 500);
  }
  if (!valid) {
    return c.json({ error: 'invalid_signature' }, 401);
  }

  let inbound;
  try {
    inbound = transport.parseInbound(rawBody, webhookId);
  } catch (err) {
    console.error('[webhook] parse failed', err);
    return c.json({ error: 'unparseable_body' }, 400);
  }

  // Non-actionable event (e.g. agent.call_ended) — acknowledge without
  // orchestrating so the provider doesn't retry, but don't run an empty turn.
  // (Claimed AFTER this so a non-actionable / unparseable delivery never burns
  // an id, which would wrongly dedup a later corrected redelivery of it.)
  if (inbound === null) {
    return c.json({ ok: true, handled: false });
  }

  // DEDUP — claim this delivery AFTER verifying (never let unsigned junk poison
  // the ledger). Only a non-empty, signed id is dedupable; a missing id (the
  // provider always sends one, so this is defensive) can't be deduped and falls
  // through to process. A losing claim is a provider retry of a message we
  // already handled -> ack and stop, no second turn, no duplicate reply.
  if (webhookId) {
    let claimed: boolean;
    try {
      claimed = await claimWebhook(webhookId);
    } catch (err) {
      // Ledger unreachable: fail OPEN (process) rather than drop the message.
      // A rare duplicate beats silently losing a real message on a DB blip.
      console.error('[webhook] dedup claim failed; processing anyway', err);
      claimed = true;
    }
    if (!claimed) {
      return c.json({ ok: true, handled: false, duplicate: true });
    }
  } else {
    console.warn('[webhook] missing X-Webhook-ID; cannot dedup this delivery');
  }

  // FAST ACK — fire-and-forget the turn (see file header). The detached promise
  // runs on Bun's event loop after this response. orchestrate is fail-closed for
  // "handled" turns; a REJECTION here is a prologue blip that did no work, so we
  // RELEASE the tentative claim to let the provider's redelivery re-run instead
  // of deduping it into a silent drop. The .catch also guards the process
  // against an unhandled rejection.
  void orchestrate(inbound, transport).catch(async (err) => {
    console.error('[webhook] orchestrate threw (background); releasing claim for retry', err);
    if (webhookId) {
      await releaseWebhook(webhookId).catch((relErr) => {
        console.error('[webhook] failed to release claim after turn error', relErr);
      });
    }
  });
  return c.json({ ok: true, accepted: true });
});
