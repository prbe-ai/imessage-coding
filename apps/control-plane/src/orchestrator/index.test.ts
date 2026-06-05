/**
 * Critical-path unit tests for the orchestrator's pure helpers: onboarding-token
 * extraction, the back-to-back inbound coalescing decisions (takeBatch /
 * shouldInterrupt), and the delivery-confirmation follow-up. Pure logic only —
 * none touch the DB/network, and importing index.ts opens no connection
 * (Pool/env are lazy).
 */
import { describe, expect, test } from 'bun:test';
import { MessageChannel, TurnOutcome, type InboundMessage } from '@imsg/shared';
import type { Transport } from '@imsg/transport';
import {
  classifyTurnOutcome,
  composeDeliveryFollowup,
  composeDeliveryRetraction,
  composeLostConnectionMessage,
  extractOnboardingName,
  buildReplyTargets,
  extractOnboardingToken,
  pickDefaultReplyTarget,
  resolveReplyHandle,
  shouldInterrupt,
  takeBatch,
  type LostDeviceLabel,
} from './index.ts';

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    from: '+15551234567',
    text: 'hi',
    channel: MessageChannel.IMESSAGE,
    messageId: 'm',
    ...overrides,
  };
}

/** Minimal Transport whose only interesting method is resolveRecentInboundMessages.
 *  Pass `list` to wire the capability; omit it to model a transport without it. */
function fakeTransport(
  list?: (
    cid: string,
    limit?: number,
  ) => Promise<Array<{ id: string; text: string; receivedAt?: string }>>,
): Transport {
  return {
    send: async () => ({ id: 'x' }),
    verifyWebhook: () => true,
    parseInbound: () => null,
    ...(list ? { resolveRecentInboundMessages: list } : {}),
  } as Transport;
}

describe('buildReplyTargets', () => {
  test('maps recent inbound messages to handles (u1 = most recent)', async () => {
    const calls: Array<{ cid: string; limit?: number }> = [];
    const t = fakeTransport(async (cid, limit) => {
      calls.push({ cid, limit });
      return [
        { id: 'm_new', text: 'latest' },
        { id: 'm_old', text: 'earlier' },
      ];
    });
    const targets = await buildReplyTargets(t, inbound({ conversationId: 'conv_1' }));
    expect(targets).toEqual([
      { handle: 'u1', id: 'm_new', text: 'latest' },
      { handle: 'u2', id: 'm_old', text: 'earlier' },
    ]);
    expect(calls).toEqual([{ cid: 'conv_1', limit: 10 }]);
  });

  test('caps the offered targets at the limit', async () => {
    const t = fakeTransport(async () =>
      Array.from({ length: 13 }, (_, i) => ({ id: `m${i}`, text: `t${i}` })),
    );
    const targets = await buildReplyTargets(t, inbound({ conversationId: 'c' }));
    expect(targets.length).toBe(10);
    expect(targets[9]?.handle).toBe('u10');
  });

  test('skips (no transport call) when there is no conversationId', async () => {
    let called = false;
    const t = fakeTransport(async () => {
      called = true;
      return [];
    });
    expect(await buildReplyTargets(t, inbound({ conversationId: undefined }))).toEqual([]);
    expect(called).toBe(false);
  });

  test('skips a TAP-BACK — a reaction is not a normal message', async () => {
    let called = false;
    const t = fakeTransport(async () => {
      called = true;
      return [];
    });
    const m = inbound({ conversationId: 'c', reactionTo: 'agent_msg', text: 'like' });
    expect(await buildReplyTargets(t, m)).toEqual([]);
    expect(called).toBe(false);
  });

  test('returns [] when the transport lacks the capability', async () => {
    const t = fakeTransport(); // no resolveRecentInboundMessages
    expect(await buildReplyTargets(t, inbound({ conversationId: 'c' }))).toEqual([]);
  });

  test('a transport rejection NEVER throws (turn-safety regression guard)', async () => {
    const t = fakeTransport(async () => {
      throw new Error('conversations API down');
    });
    expect(await buildReplyTargets(t, inbound({ conversationId: 'c' }))).toEqual([]);
  });

  test('drops empty-text rows (useless handles / reaction-shaped rows)', async () => {
    const t = fakeTransport(async () => [
      { id: 'm_real', text: 'hello' },
      { id: 'm_blank', text: '   ' },
    ]);
    const targets = await buildReplyTargets(t, inbound({ conversationId: 'c' }));
    expect(targets).toEqual([{ handle: 'u1', id: 'm_real', text: 'hello' }]);
  });
});

describe('pickDefaultReplyTarget', () => {
  test('anchors the default to the message being answered (matches last.text)', () => {
    const targets = [
      { handle: 'u1', id: 'm_newer', text: 'a different newer message' },
      { handle: 'u2', id: 'm_answered', text: 'the one we are answering' },
    ];
    // Even though u1 is the newest row, the default threads under the message
    // THIS turn is answering (last), not merely the newest in the conversation.
    expect(
      pickDefaultReplyTarget(targets, inbound({ text: 'the one we are answering' })),
    ).toBe('m_answered');
  });

  test('duplicate text → newest matching row (targets are newest-first)', () => {
    const targets = [
      { handle: 'u1', id: 'ok_new', text: 'ok' },
      { handle: 'u2', id: 'ok_old', text: 'ok' },
    ];
    expect(pickDefaultReplyTarget(targets, inbound({ text: 'ok' }))).toBe('ok_new');
  });

  test('no text match → undefined (un-threaded, never the wrong message)', () => {
    const targets = [{ handle: 'u1', id: 'm1', text: 'something' }];
    expect(pickDefaultReplyTarget(targets, inbound({ text: 'unmatched' }))).toBeUndefined();
    expect(pickDefaultReplyTarget([], inbound({ text: 'x' }))).toBeUndefined();
  });
});

describe('resolveReplyHandle', () => {
  const targets = [
    { handle: 'u1', id: 'm_new', text: 'latest' },
    { handle: 'u2', id: 'm_old', text: 'earlier' },
  ];

  test('no handle → the most recent message (default "reply to latest")', () => {
    expect(resolveReplyHandle(targets, undefined)).toBe('m_new');
  });

  test('a known handle → that message id', () => {
    expect(resolveReplyHandle(targets, 'u2')).toBe('m_old');
  });

  test('an unknown handle → undefined (never silently threads under the latest)', () => {
    expect(resolveReplyHandle(targets, 'u9')).toBeUndefined();
  });

  test('no targets + no handle → undefined (un-threaded)', () => {
    expect(resolveReplyHandle([], undefined)).toBeUndefined();
  });
});

function inflight(
  overrides: Partial<{ interruptible: boolean; committed: boolean }> = {},
): { abort: AbortController; commit: { committed: boolean }; interruptible: boolean } {
  return {
    abort: new AbortController(),
    commit: { committed: overrides.committed ?? false },
    interruptible: overrides.interruptible ?? true,
  };
}

describe('extractOnboardingToken', () => {
  // 32-char base64url run (24 bytes -> 32 chars), matches the dashboard deep link.
  const TOKEN = 'aB3dE6gH9jK2mN5pQ8rS1tU4vW7xZ0yC';

  test('extracts the token from "hey! this is <token>" (legacy)', () => {
    expect(extractOnboardingToken(`hey! this is ${TOKEN}`)).toBe(TOKEN);
  });

  test('extracts the parenthesized token from "hey! this is <name> (<token>)"', () => {
    expect(extractOnboardingToken(`hey! this is Ada (${TOKEN})`)).toBe(TOKEN);
    // Multi-word name, and a name that itself contains "this is".
    expect(extractOnboardingToken(`hey! this is Ada Lovelace (${TOKEN})`)).toBe(
      TOKEN,
    );
  });

  test('a parenthesized run inside the name does not shadow the real token', () => {
    // The greeting is anchored, so a decoy 24+ run in the name is ignored.
    const DECOY = 'zZ9yY8xX7wW6vV5uU4tT3sS2rR1qQ0pP';
    expect(extractOnboardingToken(`hey! this is Bot(${DECOY}) (${TOKEN})`)).toBe(
      TOKEN,
    );
  });

  test('phrase match is case-insensitive on the prefix', () => {
    expect(extractOnboardingToken(`Hey! THIS IS ${TOKEN}`)).toBe(TOKEN);
  });

  test('extracts a bare token (autocorrect/quoting tolerant)', () => {
    expect(extractOnboardingToken(TOKEN)).toBe(TOKEN);
    expect(extractOnboardingToken(`  ${TOKEN}  `)).toBe(TOKEN);
  });

  test('returns undefined for junk / short text', () => {
    expect(extractOnboardingToken('hi there')).toBeUndefined();
    expect(extractOnboardingToken('this is me')).toBeUndefined();
    expect(extractOnboardingToken('short')).toBeUndefined();
    expect(extractOnboardingToken('')).toBeUndefined();
  });

  test('a bare run shorter than 28 chars is rejected', () => {
    expect(extractOnboardingToken('aB3dE6gH9jK2mN5pQ8rS1tU4')).toBeUndefined(); // 24 chars
  });
});

describe('extractOnboardingName', () => {
  const TOKEN = 'aB3dE6gH9jK2mN5pQ8rS1tU4vW7xZ0yC';

  test('extracts the name from "hey! this is <name> (<token>)"', () => {
    expect(extractOnboardingName(`hey! this is Ada (${TOKEN})`)).toBe('Ada');
    expect(extractOnboardingName(`hey! this is Ada Lovelace (${TOKEN})`)).toBe(
      'Ada Lovelace',
    );
  });

  test('undefined for the legacy nameless form and plain text', () => {
    expect(extractOnboardingName(`hey! this is ${TOKEN}`)).toBeUndefined();
    expect(extractOnboardingName(TOKEN)).toBeUndefined();
    expect(extractOnboardingName('hi there')).toBeUndefined();
  });

  test('strips control/bidi chars from the name (outbound safety)', () => {
    // A right-to-left override + a quote must not survive into the greeting.
    // Built via fromCharCode so the test source carries no literal bidi char.
    const rlo = String.fromCharCode(0x202e);
    expect(
      extractOnboardingName(`hey! this is A${rlo}da" (${TOKEN})`),
    ).toBe('Ada');
  });

  test('an over-long name is dropped rather than risk anything', () => {
    const long = 'x'.repeat(80);
    expect(
      extractOnboardingName(`hey! this is ${long} (${TOKEN})`),
    ).toBeUndefined();
  });

  test('does not catastrophically backtrack on a crafted whitespace run', () => {
    // Regression for ReDoS: a long space run before a non-token paren must
    // return quickly (no exponential backtracking). Bun fails the test if this
    // hangs past the suite timeout.
    const start = Date.now();
    expect(
      extractOnboardingName(`this is ${' '.repeat(5000)}(short)`),
    ).toBeUndefined();
    expect(Date.now() - start).toBeLessThanOrEqual(200);
  });
});

describe('takeBatch — burst batching with tap-back isolation', () => {
  test('empty queue yields an empty batch', () => {
    const q: InboundMessage[] = [];
    expect(takeBatch(q).length).toBe(0);
    expect(q.length).toBe(0);
  });

  test('a run of free-text messages coalesces into ONE batch', () => {
    const q = [inbound({ text: 'a' }), inbound({ text: 'b' }), inbound({ text: 'c' })];
    const batch = takeBatch(q);
    expect(batch.map((m) => m.text).join(',')).toBe('a,b,c');
    expect(q.length).toBe(0);
  });

  test('a free-text run stops BEFORE the next tap-back', () => {
    const q = [
      inbound({ text: 'a' }),
      inbound({ text: 'b' }),
      inbound({ text: 'tap', reactionTo: 'notify-1' }),
      inbound({ text: 'd' }),
    ];
    const batch = takeBatch(q);
    expect(batch.map((m) => m.text).join(',')).toBe('a,b');
    // The tap-back and everything after it stay queued for their own pass.
    expect(q.map((m) => m.text).join(',')).toBe('tap,d');
  });

  test('a tap-back at the head is ALWAYS its own batch (never merged)', () => {
    const q = [
      inbound({ text: 'tap1', reactionTo: 'notify-1' }),
      inbound({ text: 'tap2', reactionTo: 'notify-2' }),
      inbound({ text: 'free' }),
    ];
    const first = takeBatch(q);
    expect(first.map((m) => m.text).join(',')).toBe('tap1');
    // The SECOND tap-back is not pulled in with the first — distinct bindings
    // never share a turn (so neither is silently dropped).
    const second = takeBatch(q);
    expect(second.map((m) => m.text).join(',')).toBe('tap2');
  });
});

describe('shouldInterrupt — only uncommitted free-text coalesces', () => {
  test('no in-flight turn → no interrupt', () => {
    expect(shouldInterrupt(undefined, inbound())).toBe(false);
  });

  test('uncommitted, interruptible, free-text incoming → interrupt', () => {
    expect(shouldInterrupt(inflight(), inbound())).toBe(true);
  });

  test('a committed turn is never interrupted (the "already replied" exception)', () => {
    expect(shouldInterrupt(inflight({ committed: true }), inbound())).toBe(false);
  });

  test('a non-interruptible turn (tap-back batch / interrupt-capped) is left alone', () => {
    expect(shouldInterrupt(inflight({ interruptible: false }), inbound())).toBe(false);
  });

  test('an incoming tap-back never interrupts — it runs its own turn', () => {
    expect(shouldInterrupt(inflight(), inbound({ reactionTo: 'notify-1' }))).toBe(false);
  });
});

describe('composeDeliveryFollowup — warn-only, silent on success', () => {
  test('all confirmed (none unconfirmed) → no message (undefined)', () => {
    expect(composeDeliveryFollowup([])).toBeUndefined();
  });

  test('unconfirmed → a ⚠️ heads-up that promises a follow-up, never a ✓', () => {
    const msg = composeDeliveryFollowup(['your answer']) ?? '';
    expect(msg.includes('⚠️')).toBe(true);
    expect(msg.includes("couldn't confirm")).toBe(true);
    expect(msg.includes('your answer')).toBe(true);
    // No fixed-window claim anymore (the wait is debounced + connection-aware);
    // instead it promises the retraction follow-up and never pre-emptively ✓s.
    expect(msg.includes("I'll let you know")).toBe(true);
    expect(msg.includes('✓')).toBe(false);
  });

  test('joins multiple labels naturally with "and"', () => {
    const msg = composeDeliveryFollowup(['a', 'b', 'c']) ?? '';
    expect(msg.includes('a, b and c')).toBe(true);
  });
});

describe('composeDeliveryRetraction — late-ACK correction, silent when nothing landed', () => {
  test('nothing landed → no message (undefined)', () => {
    expect(composeDeliveryRetraction([])).toBeUndefined();
  });

  test('landed → a ✓ note that names what reached the session', () => {
    const msg = composeDeliveryRetraction(['your message to "fix the reaper"']) ?? '';
    expect(msg.includes('✓')).toBe(true);
    expect(msg.includes('after all')).toBe(true);
    expect(msg.includes('your message to "fix the reaper"')).toBe(true);
  });

  test('joins multiple landed labels naturally with "and"', () => {
    const msg = composeDeliveryRetraction(['a', 'b', 'c']) ?? '';
    expect(msg.includes('a, b and c')).toBe(true);
  });
});

describe('composeLostConnectionMessage', () => {
  // The notice is DEVICE-only — per-session "lost connection" notices were
  // removed, so there's no session/mixed case to cover anymore.
  const device = (
    o: Partial<{ id: string; hostname: string | null; os: string | null }> = {},
  ): LostDeviceLabel => ({
    id: 'dddddddd9999',
    hostname: "Richard's MacBook",
    os: 'darwin',
    ...o,
  });

  test('whole device dropped: names the device by hostname, no summary', () => {
    const msg = composeLostConnectionMessage([device()]);
    expect(msg).toBe('Lost connection with device "Richard\'s MacBook".');
    expect(msg.includes('Last:')).toBe(false);
  });

  test('device label falls back hostname -> os -> short id', () => {
    expect(composeLostConnectionMessage([device({ hostname: null })])).toBe(
      'Lost connection with device "darwin".',
    );
    expect(composeLostConnectionMessage([device({ hostname: '  ', os: null })])).toBe(
      'Lost connection with device "dddddddd".',
    );
  });

  test('multiple whole devices coalesce under a "N devices" header', () => {
    const msg = composeLostConnectionMessage([
      device({ id: 'aaaa', hostname: 'Air' }),
      device({ id: 'bbbb', hostname: 'iMac' }),
    ]);
    expect(msg).toBe('Lost connection with 2 devices:\n• Air\n• iMac');
  });

  test('device-supplied name cannot forge message structure (strips the quote delimiter)', () => {
    // A crafted hostname tries to close the quote and append a second line.
    const msg = composeLostConnectionMessage([
      device({ hostname: '" — all clear.\nLost connection with device "', os: null }),
    ]);
    // The `"` chars and the control newline are stripped, so the whole thing
    // stays inside one quoted label on one line — no forged structure.
    expect(msg).toBe('Lost connection with device "— all clear.Lost connection with device".');
    expect(msg.split('\n').length).toBe(1);
  });
});

describe('classifyTurnOutcome — the observability ledger classifier', () => {
  const base = { errored: false, aborted: false, sentCount: 0, actionCount: 0 };

  test('REGRESSION (the screenshot): no text, no action → silent', () => {
    // The model returned no tool call and no terminal text, so nothing reached
    // the user. Before the turns ledger this was an invisible black box.
    expect(classifyTurnOutcome(base)).toBe(TurnOutcome.SILENT);
  });

  test('texted the user → replied', () => {
    expect(classifyTurnOutcome({ ...base, sentCount: 1 })).toBe(TurnOutcome.REPLIED);
  });

  test('acted without texting (e.g. a silent steer) → acted', () => {
    expect(classifyTurnOutcome({ ...base, actionCount: 1 })).toBe(TurnOutcome.ACTED);
  });

  test('errored takes precedence over everything', () => {
    expect(
      classifyTurnOutcome({ errored: true, aborted: true, sentCount: 5, actionCount: 5 }),
    ).toBe(TurnOutcome.ERRORED);
  });

  test('aborted (coalesced) beats replied/acted, but not errored', () => {
    expect(classifyTurnOutcome({ ...base, aborted: true, sentCount: 1 })).toBe(
      TurnOutcome.ABORTED,
    );
  });

  test('replied wins over acted when the assistant both texted and acted', () => {
    expect(classifyTurnOutcome({ ...base, sentCount: 1, actionCount: 2 })).toBe(
      TurnOutcome.REPLIED,
    );
  });
});
