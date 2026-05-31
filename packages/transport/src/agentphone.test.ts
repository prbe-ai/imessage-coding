/**
 * Critical-path unit tests for AgentPhoneTransport.verifyWebhook (Lane E, D5).
 *
 * Pure logic only — no network. Signatures are constructed with node:crypto
 * HMAC-SHA256 to match the implementation exactly. These cover the
 * safety-critical webhook authentication surface where a bug is catastrophic
 * (forged/replayed webhook -> attacker drives the coding agent).
 */
import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { AgentPhoneTransport } from './agentphone.ts';

const SECRET = 'test-webhook-secret-abc123';

/** Body-only HMAC (no timestamp binding). Hex digest, matches impl. */
function bodyOnlySig(secret: string, body: string): string {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
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

describe('AgentPhoneTransport.verifyWebhook', () => {
  test('valid body-only HMAC over raw bytes passes (no timestamp)', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const body = '{"type":"agent.message","data":{"body":"hi"}}';
    const sig = bodyOnlySig(SECRET, body);
    // Empty timestamp -> body-only fallback path.
    expect(t.verifyWebhook(body, sig, '')).toBe(true);
  });

  test('valid signature also passes when body is a Buffer', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const body = '{"type":"agent.message"}';
    const sig = bodyOnlySig(SECRET, body);
    expect(t.verifyWebhook(Buffer.from(body, 'utf8'), sig, '')).toBe(true);
  });

  test('accepts a "sha256=" prefixed signature', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const body = '{"x":1}';
    const sig = bodyOnlySig(SECRET, body);
    expect(t.verifyWebhook(body, `sha256=${sig}`, '')).toBe(true);
  });

  test('tampered body fails', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const body = '{"type":"agent.message","data":{"body":"safe"}}';
    const sig = bodyOnlySig(SECRET, body);
    const tampered = '{"type":"agent.message","data":{"body":"rm -rf /"}}';
    expect(t.verifyWebhook(tampered, sig, '')).toBe(false);
  });

  test('signature computed under a different secret fails', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const body = '{"x":1}';
    const sig = bodyOnlySig('a-different-secret', body);
    expect(t.verifyWebhook(body, sig, '')).toBe(false);
  });

  test('THROWS (fail-closed) when webhook secret is missing', () => {
    const t = new AgentPhoneTransport({ webhookSecret: undefined });
    const body = '{"x":1}';
    expect(() => t.verifyWebhook(body, 'whatever', '')).toThrow(
      /WEBHOOK_SECRET is not set/,
    );
  });

  test('THROWS (fail-closed) when webhook secret is empty string', () => {
    const t = new AgentPhoneTransport({ webhookSecret: '' });
    const body = '{"x":1}';
    expect(() => t.verifyWebhook(body, 'whatever', '')).toThrow(
      /WEBHOOK_SECRET is not set/,
    );
  });

  test('empty signature returns false (not a throw)', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    expect(t.verifyWebhook('{"x":1}', '', '')).toBe(false);
  });

  test('fresh timestamp-bound signature passes', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const body = '{"type":"agent.message","data":{"body":"go"}}';
    const ts = String(nowSeconds());
    const sig = tsBoundSig(SECRET, ts, body);
    expect(t.verifyWebhook(body, sig, ts)).toBe(true);
  });

  test('stale timestamp (>300s skew in the past) is rejected', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const body = '{"type":"agent.message"}';
    const ts = String(nowSeconds() - 301);
    // Even with a CORRECTLY computed signature, a stale timestamp is rejected.
    const sig = tsBoundSig(SECRET, ts, body);
    expect(t.verifyWebhook(body, sig, ts)).toBe(false);
  });

  test('future timestamp (>300s skew ahead) is rejected', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const body = '{"type":"agent.message"}';
    const ts = String(nowSeconds() + 301);
    const sig = tsBoundSig(SECRET, ts, body);
    expect(t.verifyWebhook(body, sig, ts)).toBe(false);
  });

  test('timestamp at the edge (~300s) still passes with a fresh-enough binding', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const body = '{"type":"agent.message"}';
    // 290s in the past — comfortably inside the 300s window.
    const ts = String(nowSeconds() - 290);
    const sig = tsBoundSig(SECRET, ts, body);
    expect(t.verifyWebhook(body, sig, ts)).toBe(true);
  });

  test('non-numeric timestamp is rejected (fail-closed)', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const body = '{"x":1}';
    const sig = tsBoundSig(SECRET, 'not-a-number', body);
    expect(t.verifyWebhook(body, sig, 'not-a-number')).toBe(false);
  });

  test('replay: a fresh-timestamp body-only signature does NOT pass on the timestamp path', () => {
    // A captured body-only signature replayed WITH a fresh timestamp must fail:
    // once a timestamp is present, the impl REQUIRES the timestamp-bound HMAC.
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const body = '{"type":"agent.message"}';
    const ts = String(nowSeconds());
    const bodyOnly = bodyOnlySig(SECRET, body);
    expect(t.verifyWebhook(body, bodyOnly, ts)).toBe(false);
  });

  test('constant-time path does not crash on signature length mismatch', () => {
    const t = new AgentPhoneTransport({ webhookSecret: SECRET });
    const body = '{"x":1}';
    // A short, wrong-length provided signature must return false, not throw.
    expect(() => t.verifyWebhook(body, 'ab', '')).not.toThrow();
    expect(t.verifyWebhook(body, 'ab', '')).toBe(false);
  });
});
