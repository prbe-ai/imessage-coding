/**
 * Critical-path unit tests for AgentPhoneTransport (Lane E, D5).
 *
 * Pure logic only — no network. Signatures are constructed with node:crypto
 * HMAC-SHA256 to match the implementation exactly. These cover the
 * safety-critical webhook authentication + parse surface where a bug is
 * catastrophic (forged/replayed webhook -> attacker drives the coding agent).
 *
 * Contract verified 2026-05-31 against docs.agentphone.ai: deliveries are
 * signed as `sha256=<hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))>` and
 * ALWAYS carry a timestamp. There is no body-only signing path.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { AgentPhoneTransport } from './agentphone.ts';

const SECRET = 'test-webhook-secret-abc123';

/** Body-only HMAC (no timestamp binding) — only used to prove it's REJECTED. */
function bodyOnlySig(secret: string, body: string): string {
  return createHmac('sha256', secret)
    .update(Buffer.from(body, 'utf8'))
    .digest('hex');
}

/** Timestamp-bound HMAC over `${timestamp}.${body}`. Matches impl. */
function tsBoundSig(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret)
    .update(Buffer.from(`${timestamp}.${body}`, 'utf8'))
    .digest('hex');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const MSG_BODY = '{"event":"agent.message","data":{"message":"hi"}}';

describe('AgentPhoneTransport.verifyWebhook', () => {
  test('fresh timestamp-bound signature passes', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const ts = String(nowSeconds());
    const sig = tsBoundSig(SECRET, ts, MSG_BODY);
    expect(t.verifyWebhook(MSG_BODY, sig, ts)).toBe(true);
  });

  test('passes when body is a Buffer', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const ts = String(nowSeconds());
    const sig = tsBoundSig(SECRET, ts, MSG_BODY);
    expect(t.verifyWebhook(Buffer.from(MSG_BODY, 'utf8'), sig, ts)).toBe(true);
  });

  test('accepts a "sha256=" prefixed signature', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const ts = String(nowSeconds());
    const sig = tsBoundSig(SECRET, ts, MSG_BODY);
    expect(t.verifyWebhook(MSG_BODY, `sha256=${sig}`, ts)).toBe(true);
  });

  test('tampered body fails', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const ts = String(nowSeconds());
    const sig = tsBoundSig(SECRET, ts, MSG_BODY);
    const tampered = '{"event":"agent.message","data":{"message":"rm -rf /"}}';
    expect(t.verifyWebhook(tampered, sig, ts)).toBe(false);
  });

  test('signature computed under a different secret fails', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const ts = String(nowSeconds());
    const sig = tsBoundSig('a-different-secret', ts, MSG_BODY);
    expect(t.verifyWebhook(MSG_BODY, sig, ts)).toBe(false);
  });

  test('THROWS (fail-closed) when webhook secret is missing', () => {
    const t = new AgentPhoneTransport({ webhookSecret: undefined });
    expect(() => t.verifyWebhook(MSG_BODY, 'whatever', '123')).toThrow(
      /WEBHOOK_SECRET is not set/,
    );
  });

  test('THROWS (fail-closed) when webhook secret is empty string', () => {
    const t = new AgentPhoneTransport({ webhookSecret: '' });
    expect(() => t.verifyWebhook(MSG_BODY, 'whatever', '123')).toThrow(
      /WEBHOOK_SECRET is not set/,
    );
  });

  test('empty signature returns false (not a throw)', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    expect(t.verifyWebhook(MSG_BODY, '', String(nowSeconds()))).toBe(false);
  });

  test('MISSING timestamp is rejected — no body-only fallback', () => {
    // A correctly body-only-signed delivery with no timestamp header must FAIL.
    // This is the replay-protection hardening: there is no unauthenticated path.
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const sig = bodyOnlySig(SECRET, MSG_BODY);
    expect(t.verifyWebhook(MSG_BODY, sig, '')).toBe(false);
  });

  test('stale timestamp (>300s skew in the past) is rejected', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const ts = String(nowSeconds() - 301);
    const sig = tsBoundSig(SECRET, ts, MSG_BODY);
    expect(t.verifyWebhook(MSG_BODY, sig, ts)).toBe(false);
  });

  test('future timestamp (>300s skew ahead) is rejected', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const ts = String(nowSeconds() + 301);
    const sig = tsBoundSig(SECRET, ts, MSG_BODY);
    expect(t.verifyWebhook(MSG_BODY, sig, ts)).toBe(false);
  });

  test('timestamp at the edge (~290s) still passes', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const ts = String(nowSeconds() - 290);
    const sig = tsBoundSig(SECRET, ts, MSG_BODY);
    expect(t.verifyWebhook(MSG_BODY, sig, ts)).toBe(true);
  });

  test('non-numeric timestamp is rejected (fail-closed)', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const sig = tsBoundSig(SECRET, 'not-a-number', MSG_BODY);
    expect(t.verifyWebhook(MSG_BODY, sig, 'not-a-number')).toBe(false);
  });

  test('replay: a body-only signature does NOT pass with a fresh timestamp', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const ts = String(nowSeconds());
    const bodyOnly = bodyOnlySig(SECRET, MSG_BODY);
    expect(t.verifyWebhook(MSG_BODY, bodyOnly, ts)).toBe(false);
  });

  test('constant-time path does not crash on signature length mismatch', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const ts = String(nowSeconds());
    expect(() => t.verifyWebhook(MSG_BODY, 'ab', ts)).not.toThrow();
    expect(t.verifyWebhook(MSG_BODY, 'ab', ts)).toBe(false);
  });
});

/**
 * parseInbound maps the LIVE AgentPhone envelope (verified 2026-05-31 against
 * docs.agentphone.ai). The shape is intentionally exercised here because the
 * field names + nesting are the exact thing that silently broke before:
 * channel/conversationState/recentHistory are TOP-LEVEL, the body is
 * `data.message`, and inbound messages have no body-level id (it comes from the
 * X-Webhook-ID header, passed in as `webhookId`).
 */
describe('AgentPhoneTransport.parseInbound', () => {
  const t = new AgentPhoneTransport({ webhookSecret: SECRET });

  test('agent.message: text=data.message, from=data.from, channel top-level, id=webhookId', () => {
    const body = JSON.stringify({
      event: 'agent.message',
      channel: 'imessage',
      agentId: 'agt_1',
      data: {
        conversationId: 'conv_1',
        from: '+15551112222',
        message: 'ship it',
      },
      conversationState: { orderId: 'ORD-1' },
      recentHistory: [
        { content: 'hi', direction: 'inbound', channel: 'imessage', at: 't0' },
      ],
    });
    const m = t.parseInbound(body, 'whk_123');
    expect(m).not.toBe(null);
    expect(m?.text).toBe('ship it');
    expect(m?.from).toBe('+15551112222');
    expect(m?.channel).toBe('imessage');
    expect(m?.messageId).toBe('whk_123');
    expect(m?.conversationId).toBe('conv_1');
    expect(m?.conversationState?.['orderId']).toBe('ORD-1');
    expect(m?.recentHistory?.length).toBe(1);
    expect(m?.reactionTo).toBe(undefined);
  });

  test('agent.reaction: text=reactionType, from=fromNumber, reactionTo=data.messageId', () => {
    const body = JSON.stringify({
      event: 'agent.reaction',
      channel: 'imessage',
      data: {
        reactionType: 'like',
        messageId: 'msg_42',
        messageBody: 'Run the migration?',
        fromNumber: '+15553334444',
      },
    });
    const m = t.parseInbound(body, 'whk_456');
    expect(m).not.toBe(null);
    expect(m?.text).toBe('like');
    expect(m?.from).toBe('+15553334444');
    expect(m?.reactionTo).toBe('msg_42');
    expect(m?.messageId).toBe('whk_456');
  });

  test('top-level sms channel is preserved (not defaulted to imessage)', () => {
    const body = JSON.stringify({
      event: 'agent.message',
      channel: 'sms',
      data: { from: '+15550000000', message: 'yo' },
    });
    expect(t.parseInbound(body, 'w')?.channel).toBe('sms');
  });

  test('an unknown channel falls back to imessage', () => {
    const body = JSON.stringify({
      event: 'agent.message',
      channel: 'carrier-pigeon',
      data: { from: '+1', message: 'coo' },
    });
    expect(t.parseInbound(body, 'w')?.channel).toBe('imessage');
  });

  test('non-actionable event (agent.call_ended) returns null', () => {
    const body = JSON.stringify({
      event: 'agent.call_ended',
      channel: 'voice',
      data: { from: '+15550000000', transcript: 'bye', callId: 'call_1' },
    });
    expect(t.parseInbound(body, 'whk_call')).toBe(null);
  });

  test('a non-object JSON body throws (caller 400s, does not orchestrate)', () => {
    const t2 = new AgentPhoneTransport({ webhookSecret: SECRET });
    expect(() => t2.parseInbound('"just a string"', 'w')).toThrow();
    expect(() => t2.parseInbound('42', 'w')).toThrow();
    expect(() => t2.parseInbound('null', 'w')).toThrow();
    expect(() => t2.parseInbound('[]', 'w')).toThrow();
  });
});
