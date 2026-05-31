/**
 * POST /api/agentphone/webhook — inbound message ingress.
 *
 * 1. Read the RAW request body (bytes) — HMAC must be computed over exactly
 *    what the provider signed, so we never re-serialize.
 * 2. Verify the signature via the Transport (HMAC-SHA256, constant-time,
 *    hard-fails if the secret is unset). A bad/absent signature -> 401.
 * 3. parseInbound -> normalized InboundMessage -> orchestrator.
 *
 * We ALWAYS return 200 once the signature is valid (even if orchestration
 * decides to no-op) so the provider does not retry-storm; orchestration errors
 * are logged, never surfaced as 5xx that trigger replays.
 */
import { Hono } from 'hono';
import {
  AGENTPHONE_SIGNATURE_HEADER,
  AGENTPHONE_TIMESTAMP_HEADER,
} from '@imsg/transport';
import { orchestrate } from '../orchestrator/index.ts';
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
    inbound = transport.parseInbound(rawBody);
  } catch (err) {
    console.error('[webhook] parse failed', err);
    return c.json({ error: 'unparseable_body' }, 400);
  }

  // Orchestrate asynchronously-safe but awaited: errors are swallowed into a
  // logged result so we still 200 the provider.
  try {
    const result = await orchestrate(inbound, transport);
    return c.json({ ok: true, handled: result.handled });
  } catch (err) {
    console.error('[webhook] orchestrate threw', err);
    return c.json({ ok: true, handled: false });
  }
});
