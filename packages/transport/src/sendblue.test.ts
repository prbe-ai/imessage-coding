/**
 * Critical-path unit tests for SendblueTransport.
 *
 * Pure logic + a stubbed global fetch (no network). Covers the safety-critical
 * webhook auth + inbound parse surface and the send request shape.
 *
 * Contract verified 2026-06-30 against docs.sendblue.com: Sendblue does NOT
 * HMAC-sign webhooks (we authenticate via a URL-path secret compared here), the
 * stable per-message id `message_handle` lives in the BODY, and inbound tapbacks
 * are not delivered. See sendblue.ts for the full provider notes.
 */
import { describe, expect, test } from 'bun:test';
import { MessageChannel } from '@imsg/shared';
import { SendblueTransport, SENDBLUE_DEFAULT_API_BASE } from './sendblue.ts';

const SECRET = 'test-webhook-secret-abc123';

/** A representative inbound iMessage webhook body (verified shape). */
const INBOUND_IMESSAGE = JSON.stringify({
  content: 'yes do it',
  is_outbound: false,
  status: 'RECEIVED',
  message_handle: '99DCC379-DD76-4712-BA65-11EFB33B8CD6',
  from_number: '+19998887777',
  to_number: '+15122164639',
  media_url: '',
  message_type: 'message',
  group_id: '',
  service: 'iMessage',
});

/** Swap globalThis.fetch for a stub; returns a restore fn. */
function stubFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = ((url: unknown, init: unknown) =>
    handler(String(url), (init ?? {}) as RequestInit)) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

/** Assert an async fn rejects with a message matching `re` (the shim has no
 *  `.rejects` matcher, so we catch + assert manually). */
async function rejectsWith(
  fn: () => Promise<unknown>,
  re: RegExp,
): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect((err as Error).message).toMatch(re);
}

// -----------------------------------------------------------------------------
// verifyWebhook — URL-path shared-secret compare (Sendblue does not HMAC).
// -----------------------------------------------------------------------------
describe('SendblueTransport.verifyWebhook', () => {
  test('matching secret token passes', () => {
    const t = new SendblueTransport({ webhookSecret: SECRET });
    expect(t.verifyWebhook(INBOUND_IMESSAGE, SECRET, '')).toBe(true);
  });

  test('matching secret passes regardless of body (no body binding) + Buffer ok', () => {
    const t = new SendblueTransport({ webhookSecret: SECRET });
    expect(
      t.verifyWebhook(Buffer.from('anything at all', 'utf8'), SECRET, ''),
    ).toBe(true);
  });

  test('timestamp argument is ignored', () => {
    const t = new SendblueTransport({ webhookSecret: SECRET });
    expect(t.verifyWebhook(INBOUND_IMESSAGE, SECRET, 'whatever')).toBe(true);
  });

  test('wrong secret token fails', () => {
    const t = new SendblueTransport({ webhookSecret: SECRET });
    expect(t.verifyWebhook(INBOUND_IMESSAGE, 'not-the-secret', '')).toBe(false);
  });

  test('a token that is a prefix of the secret fails (length mismatch)', () => {
    const t = new SendblueTransport({ webhookSecret: SECRET });
    expect(t.verifyWebhook(INBOUND_IMESSAGE, SECRET.slice(0, -1), '')).toBe(
      false,
    );
  });

  test('empty token returns false (not a throw)', () => {
    const t = new SendblueTransport({ webhookSecret: SECRET });
    expect(t.verifyWebhook(INBOUND_IMESSAGE, '', '')).toBe(false);
  });

  test('THROWS (fail-closed) when webhook secret is missing', () => {
    const t = new SendblueTransport({ webhookSecret: undefined });
    expect(() => t.verifyWebhook(INBOUND_IMESSAGE, 'whatever', '')).toThrow(
      /SENDBLUE_WEBHOOK_SECRET is not set/,
    );
  });

  test('THROWS (fail-closed) when webhook secret is empty string', () => {
    const t = new SendblueTransport({ webhookSecret: '' });
    expect(() => t.verifyWebhook(INBOUND_IMESSAGE, 'whatever', '')).toThrow(
      /SENDBLUE_WEBHOOK_SECRET is not set/,
    );
  });
});

// -----------------------------------------------------------------------------
// parseInbound — map Sendblue's body to the normalized InboundMessage.
// -----------------------------------------------------------------------------
describe('SendblueTransport.parseInbound', () => {
  const t = new SendblueTransport({ webhookSecret: SECRET });

  test('maps an inbound iMessage', () => {
    const m = t.parseInbound(INBOUND_IMESSAGE);
    expect(m === null).toBe(false);
    expect(m!.from).toBe('+19998887777');
    expect(m!.text).toBe('yes do it');
    expect(m!.channel).toBe(MessageChannel.IMESSAGE);
    expect(m!.messageId).toBe('99DCC379-DD76-4712-BA65-11EFB33B8CD6');
    // 1:1 chat: group_id '' -> no conversationId, and no media.
    expect(m!.conversationId).toBeUndefined();
    expect(m!.mediaUrls).toBeUndefined();
  });

  test('parses a Buffer body', () => {
    const m = t.parseInbound(Buffer.from(INBOUND_IMESSAGE, 'utf8'));
    expect(m!.from).toBe('+19998887777');
  });

  test('service "SMS" maps to the SMS channel', () => {
    const body = JSON.stringify({
      content: 'hi',
      from_number: '+19998887777',
      message_handle: 'mh-1',
      service: 'SMS',
    });
    expect(t.parseInbound(body)!.channel).toBe(MessageChannel.SMS);
  });

  test('non-empty group_id becomes conversationId', () => {
    const body = JSON.stringify({
      content: 'hi',
      from_number: '+19998887777',
      message_handle: 'mh-1',
      group_id: 'grp-42',
      service: 'iMessage',
    });
    expect(t.parseInbound(body)!.conversationId).toBe('grp-42');
  });

  test('media_url becomes mediaUrls; text may be empty', () => {
    const body = JSON.stringify({
      content: '',
      from_number: '+19998887777',
      message_handle: 'mh-1',
      media_url: 'https://cdn.sendblue.co/media/abc.jpg',
      service: 'iMessage',
    });
    const m = t.parseInbound(body);
    expect(m === null).toBe(false);
    expect(m!.text).toBe('');
    expect(m!.mediaUrls).toEqual(['https://cdn.sendblue.co/media/abc.jpg']);
  });

  test('is_outbound:true (our own status echo) -> null', () => {
    const body = JSON.stringify({
      content: 'sent by us',
      is_outbound: true,
      from_number: '+15122164639',
      message_handle: 'mh-1',
      service: 'iMessage',
    });
    expect(t.parseInbound(body) === null).toBe(true);
  });

  test('missing from_number -> null (non-actionable)', () => {
    const body = JSON.stringify({
      content: 'orphan',
      message_handle: 'mh-1',
      service: 'iMessage',
    });
    expect(t.parseInbound(body) === null).toBe(true);
  });

  test('empty content AND no media -> null', () => {
    const body = JSON.stringify({
      content: '',
      from_number: '+19998887777',
      message_handle: 'mh-1',
      media_url: '',
      service: 'iMessage',
    });
    expect(t.parseInbound(body) === null).toBe(true);
  });

  test('throws on a non-object body', () => {
    for (const bad of ['null', '42', '"x"', '[]', 'true']) {
      expect(() => t.parseInbound(bad)).toThrow(/not a JSON object/);
    }
  });
});

// -----------------------------------------------------------------------------
// send — request shape + result mapping (stubbed fetch).
// -----------------------------------------------------------------------------
describe('SendblueTransport.send', () => {
  test('POSTs to /api/send-message with auth headers and returns message_handle', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const restore = stubFetch(async (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ message_handle: 'mh-123', status: 'QUEUED' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    try {
      const t = new SendblueTransport({
        apiKeyId: 'kid',
        apiSecret: 'sec',
        fromNumber: '+15550000000',
      });
      const r = await t.send({ to: '+15551112222', text: 'hello' });
      expect(r.id).toBe('mh-123');
      expect(r.replyParentUnresolved).toBeUndefined();
      expect(captured!.url).toBe(`${SENDBLUE_DEFAULT_API_BASE}/api/send-message`);
      const headers = captured!.init.headers as Record<string, string>;
      expect(headers['sb-api-key-id']).toBe('kid');
      expect(headers['sb-api-secret-key']).toBe('sec');
      expect(JSON.parse(captured!.init.body as string)).toEqual({
        number: '+15551112222',
        content: 'hello',
        from_number: '+15550000000',
      });
    } finally {
      restore();
    }
  });

  test('omits from_number when not configured', async () => {
    let body: Record<string, unknown> | undefined;
    const restore = stubFetch(async (_url, init) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ message_handle: 'mh-9' }), {
        status: 200,
      });
    });
    try {
      const t = new SendblueTransport({ apiKeyId: 'kid', apiSecret: 'sec' });
      await t.send({ to: '+15551112222', text: 'hi' });
      expect(body).toEqual({ number: '+15551112222', content: 'hi' });
      expect('from_number' in (body as object)).toBe(false);
    } finally {
      restore();
    }
  });

  test('a requested reply target is dropped but flagged (message still sends)', async () => {
    const restore = stubFetch(async () =>
      new Response(JSON.stringify({ message_handle: 'mh-7' }), { status: 200 }),
    );
    try {
      const t = new SendblueTransport({ apiKeyId: 'kid', apiSecret: 'sec' });
      const r = await t.send({
        to: '+15551112222',
        text: 'reply',
        replyToMessageId: 'some-id',
      });
      expect(r.id).toBe('mh-7');
      expect(r.replyParentUnresolved).toBe(true);
    } finally {
      restore();
    }
  });

  test('throws when API credentials are missing', async () => {
    const t = new SendblueTransport({ apiKeyId: undefined, apiSecret: undefined });
    await rejectsWith(
      () => t.send({ to: '+1', text: 'x' }),
      /SENDBLUE_API_KEY_ID \/ SENDBLUE_API_SECRET is not set/,
    );
  });

  test('throws on a non-2xx response', async () => {
    const restore = stubFetch(async () =>
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
    );
    try {
      const t = new SendblueTransport({ apiKeyId: 'kid', apiSecret: 'sec' });
      await rejectsWith(
        () => t.send({ to: '+1', text: 'x' }),
        /SendblueTransport\.send failed: 429/,
      );
    } finally {
      restore();
    }
  });
});
