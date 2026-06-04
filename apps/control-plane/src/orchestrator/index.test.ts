/**
 * Critical-path unit tests for the orchestrator's pure helpers: onboarding-token
 * extraction, the back-to-back inbound coalescing decisions (takeBatch /
 * shouldInterrupt), and the delivery-confirmation follow-up. Pure logic only —
 * none touch the DB/network, and importing index.ts opens no connection
 * (Pool/env are lazy).
 */
import { describe, expect, test } from 'bun:test';
import { MessageChannel, TurnOutcome, type InboundMessage } from '@imsg/shared';
import {
  classifyTurnOutcome,
  composeDeliveryFollowup,
  composeDeliveryRetraction,
  composeLostConnectionMessage,
  extractOnboardingToken,
  shouldInterrupt,
  takeBatch,
  type EndedEntry,
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

  test('extracts the token from "hey! this is <token>"', () => {
    expect(extractOnboardingToken(`hey! this is ${TOKEN}`)).toBe(TOKEN);
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
  const session = (o: Partial<{ id: string; title: string | null }> = {}): EndedEntry => ({
    kind: 'session',
    id: '0123456789abcdef',
    title: 'fix the reaper',
    ...o,
  });
  const device = (
    o: Partial<{ id: string; hostname: string | null; os: string | null }> = {},
  ): EndedEntry => ({
    kind: 'device',
    id: 'dddddddd9999',
    hostname: "Richard's MacBook",
    os: 'darwin',
    ...o,
  });

  test('single session: names the session only, no summary', () => {
    const msg = composeLostConnectionMessage([session()]);
    expect(msg).toBe('Lost connection with session "fix the reaper".');
    expect(msg.includes('Last:')).toBe(false);
  });

  test('null/blank title falls back to the short id', () => {
    expect(composeLostConnectionMessage([session({ title: null })])).toBe(
      'Lost connection with session "01234567".',
    );
    expect(composeLostConnectionMessage([session({ title: '   ' })])).toBe(
      'Lost connection with session "01234567".',
    );
  });

  test('multiple sessions coalesce into one bulleted message, no summaries', () => {
    const msg = composeLostConnectionMessage([
      session({ id: 'aaaaaaaa1111', title: 'A' }),
      session({ id: 'bbbbbbbb2222', title: 'B' }),
    ]);
    expect(msg).toBe('Lost connection with 2 sessions:\n• A\n• B');
  });

  test('whole device dropped: names the device by hostname, not its sessions', () => {
    expect(composeLostConnectionMessage([device()])).toBe(
      'Lost connection with device "Richard\'s MacBook".',
    );
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

  test('mixed device + session: each bullet labels its kind', () => {
    const msg = composeLostConnectionMessage([
      device({ hostname: 'iMac' }),
      session({ title: 'fix the reaper' }),
    ]);
    expect(msg).toBe('Lost connection:\n• device "iMac"\n• session "fix the reaper"');
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
