/**
 * Critical-path unit tests for the orchestrator's pure helpers: onboarding-token
 * extraction, the back-to-back inbound coalescing decisions (takeBatch /
 * shouldInterrupt), and the delivery-confirmation follow-up. Pure logic only —
 * none touch the DB/network, and importing index.ts opens no connection
 * (Pool/env are lazy).
 */
import { describe, expect, test } from 'bun:test';
import { MessageChannel, type InboundMessage } from '@imsg/shared';
import {
  composeDeliveryFollowup,
  extractOnboardingToken,
  shouldInterrupt,
  takeBatch,
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

  test('unconfirmed → a ⚠️ heads-up that names the 30s window, never a ✓', () => {
    const msg = composeDeliveryFollowup(['your answer']) ?? '';
    expect(msg.includes('⚠️')).toBe(true);
    expect(msg.includes("couldn't confirm")).toBe(true);
    expect(msg.includes('your answer')).toBe(true);
    expect(msg.includes('30s')).toBe(true);
    expect(msg.includes('✓')).toBe(false);
  });

  test('joins multiple labels naturally with "and"', () => {
    const msg = composeDeliveryFollowup(['a', 'b', 'c']) ?? '';
    expect(msg.includes('a, b and c')).toBe(true);
  });
});
