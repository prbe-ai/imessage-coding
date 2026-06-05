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
import { AgentPhoneTransport, extractProviderMessageId } from './agentphone.ts';

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

  test('agent.message: data.mediaUrl is surfaced as mediaUrls[]', () => {
    const body = JSON.stringify({
      event: 'agent.message',
      channel: 'mms',
      data: { from: '+1', message: 'look', mediaUrl: 'https://cdn.example/a.jpg' },
    });
    expect(t.parseInbound(body, 'w')?.mediaUrls).toEqual([
      'https://cdn.example/a.jpg',
    ]);
  });

  test('a plural data.mediaUrls array is normalized + deduped with mediaUrl', () => {
    const body = JSON.stringify({
      event: 'agent.message',
      channel: 'mms',
      data: {
        from: '+1',
        message: '',
        mediaUrl: 'https://cdn.example/a.jpg',
        // dup of mediaUrl, a fresh url, plus junk entries that must be dropped
        mediaUrls: ['https://cdn.example/a.jpg', 'https://cdn.example/b.png', '', 7],
      },
    });
    expect(t.parseInbound(body, 'w')?.mediaUrls).toEqual([
      'https://cdn.example/a.jpg',
      'https://cdn.example/b.png',
    ]);
  });

  test('no media → mediaUrls is omitted (a null mediaUrl is not surfaced)', () => {
    const body = JSON.stringify({
      event: 'agent.message',
      channel: 'imessage',
      data: { from: '+1', message: 'hi', mediaUrl: null },
    });
    expect(t.parseInbound(body, 'w')?.mediaUrls).toBe(undefined);
  });

  test('a reaction never carries media even if mediaUrl is present', () => {
    const body = JSON.stringify({
      event: 'agent.reaction',
      channel: 'imessage',
      data: {
        reactionType: 'like',
        messageId: 'm',
        fromNumber: '+1',
        mediaUrl: 'https://cdn.example/a.jpg',
      },
    });
    expect(t.parseInbound(body, 'w')?.mediaUrls).toBe(undefined);
  });
});

describe('extractProviderMessageId', () => {
  test('pulls the real message id out of a del_<id>_<numberId> webhook id', () => {
    expect(extractProviderMessageId('del_cmq0ho43a02mx8xzadsqzhrfs_cmpuda5m')).toBe(
      'cmq0ho43a02mx8xzadsqzhrfs',
    );
  });

  test('takes the segment right after del_ even with extra suffix segments', () => {
    expect(extractProviderMessageId('del_MSG123_num_extra')).toBe('MSG123');
  });

  test('returns undefined for a non-del shape (caller falls back to a lookup)', () => {
    expect(extractProviderMessageId('plain-webhook-id')).toBeUndefined();
    expect(extractProviderMessageId('del_only')).toBeUndefined(); // no suffix segment
    expect(extractProviderMessageId('')).toBeUndefined();
    expect(extractProviderMessageId(undefined)).toBeUndefined();
  });
});

describe('AgentPhoneTransport.parseInbound — providerMessageId', () => {
  const t = new AgentPhoneTransport({ webhookSecret: SECRET });

  test('parses the real message id from the X-Webhook-ID', () => {
    const body = JSON.stringify({
      event: 'agent.message',
      channel: 'imessage',
      data: { from: '+1', message: 'hi', conversationId: 'c1' },
    });
    const m = t.parseInbound(body, 'del_realMsgId99_num1');
    expect(m?.messageId).toBe('del_realMsgId99_num1'); // dedup key unchanged
    expect(m?.providerMessageId).toBe('realMsgId99'); // real reply target
  });

  test('leaves providerMessageId undefined for an unexpected webhook-id shape', () => {
    const body = JSON.stringify({ event: 'agent.message', channel: 'imessage', data: { message: 'hi' } });
    expect(t.parseInbound(body, 'whk_plain')?.providerMessageId).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Outbound reply threading (reply_to_message_id) — network is stubbed.
// -----------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

/** A transport with creds set so send()/resolve() reach the (stubbed) network. */
function wired(): AgentPhoneTransport {
  return new AgentPhoneTransport({
    apiKey: 'k_test',
    agentId: 'agt_test',
    webhookSecret: SECRET,
  });
}

/** Capture an async rejection's message (this project's bun:test types lack
 *  `.rejects`/`mock`, so assert on a captured string instead). */
async function caught(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Install a queue-backed fetch stub for ONE test, always restoring after (this
 *  project's bun:test has no beforeEach/afterEach in its type defs). The handler
 *  pops the next queued Response; `calls` records each outgoing request. */
async function withSend(
  queue: Response[],
  run: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const next = queue.shift();
    if (!next) throw new Error('test: no queued response');
    return next;
  }) as unknown as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const replyBody = (call?: { init?: RequestInit }): Record<string, unknown> =>
  JSON.parse(String(call?.init?.body));

describe('AgentPhoneTransport.send — reply threading + 404 safety net', () => {
  test('forwards reply_to_message_id when set', async () => {
    await withSend([jsonResponse(200, { id: 'm_1' })], async (calls) => {
      const res = await wired().send({ to: '+1', text: 'hi', replyToMessageId: 'msg_real' });
      expect(res.id).toBe('m_1');
      expect(calls.length).toBe(1);
      expect(replyBody(calls[0])['reply_to_message_id']).toBe('msg_real');
    });
  });

  test('omits reply_to_message_id when not set', async () => {
    await withSend([jsonResponse(200, { id: 'm_2' })], async (calls) => {
      await wired().send({ to: '+1', text: 'hi' });
      expect('reply_to_message_id' in replyBody(calls[0])).toBe(false);
    });
  });

  test('reply-target 404 retries ONCE without the parent and still delivers', async () => {
    await withSend(
      [
        textResponse(404, '{"detail":"Reply target not found."}'),
        jsonResponse(200, { id: 'm_3' }),
      ],
      async (calls) => {
        const res = await wired().send({ to: '+1', text: 'hi', replyToMessageId: 'stale_id' });
        expect(res.id).toBe('m_3');
        expect(calls.length).toBe(2);
        expect(replyBody(calls[0])['reply_to_message_id']).toBe('stale_id'); // threaded
        expect('reply_to_message_id' in replyBody(calls[1])).toBe(false); // un-threaded retry
      },
    );
  });

  test('a non-reply 404 throws and does NOT retry', async () => {
    await withSend([textResponse(404, '{"detail":"Agent not found."}')], async (calls) => {
      const msg = await caught(wired().send({ to: '+1', text: 'hi', replyToMessageId: 'x' }));
      expect(msg !== undefined && /send failed: 404/.test(msg)).toBe(true);
      expect(calls.length).toBe(1);
    });
  });

  test('a reply-target 404 with NO parent set just throws (nothing to strip)', async () => {
    await withSend([textResponse(404, '{"detail":"Reply target not found."}')], async (calls) => {
      const msg = await caught(wired().send({ to: '+1', text: 'hi' }));
      expect(msg !== undefined && /send failed: 404/.test(msg)).toBe(true);
      expect(calls.length).toBe(1);
    });
  });

  test('reply_parent_unresolved:true is surfaced on the result', async () => {
    await withSend(
      [jsonResponse(200, { id: 'm_4', reply_parent_unresolved: true })],
      async () => {
        const res = await wired().send({ to: '+1', text: 'hi', replyToMessageId: 'msg' });
        expect(res.id).toBe('m_4');
        expect(res.replyParentUnresolved).toBe(true);
      },
    );
  });

  test('reply_parent_unresolved absent → result flag is undefined (no false noise)', async () => {
    await withSend([jsonResponse(200, { id: 'm_5' })], async () => {
      const res = await wired().send({ to: '+1', text: 'hi' });
      expect(res.replyParentUnresolved).toBeUndefined();
    });
  });
});

/** As withSend, but for the GET resolver: stub returns `responder()` and the
 *  test body gets a `lastUrl()` accessor. Always restores fetch. */
async function withResolve(
  responder: () => Promise<Response>,
  run: (lastUrl: () => string) => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  let lastUrl = '';
  globalThis.fetch = (async (url: unknown) => {
    lastUrl = String(url);
    return responder();
  }) as unknown as typeof fetch;
  try {
    await run(() => lastUrl);
  } finally {
    globalThis.fetch = real;
  }
}

describe('AgentPhoneTransport.resolveRecentInboundMessages', () => {
  test('returns inbound messages newest-first with their ids (ignores outbound)', async () => {
    await withResolve(
      async () =>
        jsonResponse(200, {
          items: [
            { id: 'in_1', body: 'ship it', direction: 'inbound', receivedAt: '2026-01-02T00:00:00Z' },
            { id: 'out_1', body: 'on it', direction: 'outbound', receivedAt: '2026-01-02T00:01:00Z' },
            { id: 'in_0', body: 'hello', direction: 'inbound', receivedAt: '2026-01-01T00:00:00Z' },
          ],
        }),
      async () => {
        const r = await wired().resolveRecentInboundMessages('conv_1');
        expect(r.map((m) => m.id).join(',')).toBe('in_1,in_0'); // newest first, inbound only
        expect(r[0]?.id).toBe('in_1');
        expect(r[0]?.text).toBe('ship it');
        expect(r[0]?.receivedAt).toBe('2026-01-02T00:00:00Z');
      },
    );
  });

  test('sorts newest-first by receivedAt regardless of input order', async () => {
    await withResolve(
      async () =>
        jsonResponse(200, {
          items: [
            { id: 'b', body: 'two', direction: 'inbound', receivedAt: '2026-01-01T00:00:02Z' },
            { id: 'a', body: 'one', direction: 'inbound', receivedAt: '2026-01-01T00:00:01Z' },
            { id: 'c', body: 'three', direction: 'inbound', receivedAt: '2026-01-01T00:00:03Z' },
          ],
        }),
      async () => {
        const r = await wired().resolveRecentInboundMessages('c');
        expect(r.map((m) => m.id).join(',')).toBe('c,b,a');
      },
    );
  });

  test('rows missing receivedAt sort last; missing body → ""', async () => {
    await withResolve(
      async () =>
        jsonResponse(200, {
          items: [
            { id: 'no_at', direction: 'inbound' },
            { id: 'has_at', body: 'hi', direction: 'inbound', receivedAt: '2026-01-01T00:00:00Z' },
          ],
        }),
      async () => {
        const r = await wired().resolveRecentInboundMessages('c');
        expect(r.map((m) => m.id).join(',')).toBe('has_at,no_at');
        expect(r.find((m) => m.id === 'no_at')?.text).toBe('');
      },
    );
  });

  test('no inbound rows → []', async () => {
    await withResolve(
      async () => jsonResponse(200, { items: [{ id: 'o', body: 'x', direction: 'outbound' }] }),
      async () => {
        expect((await wired().resolveRecentInboundMessages('c')).length).toBe(0);
      },
    );
  });

  test('non-200 → []', async () => {
    await withResolve(
      async () => textResponse(500, 'boom'),
      async () => {
        expect((await wired().resolveRecentInboundMessages('c')).length).toBe(0);
      },
    );
  });

  test('network error → [] (best-effort, never throws)', async () => {
    await withResolve(
      () => Promise.reject(new Error('ECONNRESET')),
      async () => {
        expect((await wired().resolveRecentInboundMessages('c')).length).toBe(0);
      },
    );
  });

  test('tolerates a bare-array envelope', async () => {
    await withResolve(
      async () => jsonResponse(200, [{ id: 'in_1', body: 'hi', direction: 'inbound', receivedAt: 't1' }]),
      async () => {
        const r = await wired().resolveRecentInboundMessages('c');
        expect(r.map((m) => m.id).join(',')).toBe('in_1');
      },
    );
  });

  test('hits the conversation-messages endpoint with the given limit (id url-encoded)', async () => {
    await withResolve(
      async () => jsonResponse(200, { items: [] }),
      async (lastUrl) => {
        await wired().resolveRecentInboundMessages('conv ab/cd', 6);
        expect(lastUrl().includes('/v1/conversations/conv%20ab%2Fcd/messages')).toBe(true);
        expect(lastUrl().includes('limit=6')).toBe(true);
      },
    );
  });
});
