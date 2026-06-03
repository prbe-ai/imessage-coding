/**
 * Unit tests for the SAFETY HINT helpers. There is no longer a code-enforced
 * destructive-approval gate (the user dropped binding everywhere — the LLM has
 * final say). What remains are the pure signals the model weighs: which pending
 * attention a reply unambiguously refers to (`deterministicTarget`), tool
 * classification (`isDestructiveTool`/`isPermissionAttention`), and the action↔kind
 * shape rules (`actionAllowedForKind`). Pure logic — no DB, no network.
 */
import { describe, expect, test } from 'bun:test';
import {
  AttentionKind,
  MessageChannel,
  RequestAction,
  type AttentionEvent,
  type InboundMessage,
} from '@imsg/shared';
import {
  actionAllowedForKind,
  deterministicTarget,
  isDestructiveTool,
  isPermissionAttention,
} from './safety.ts';

function attention(overrides: Partial<AttentionEvent> = {}): AttentionEvent {
  return {
    id: 'att-default',
    deviceId: 'dev-1',
    sessionId: 'sess-1',
    kind: AttentionKind.PERMISSION,
    createdAt: '2026-05-31T00:00:00.000Z',
    ...overrides,
  };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    from: '+15551234567',
    text: 'yes',
    channel: MessageChannel.IMESSAGE,
    messageId: 'msg-in-1',
    ...overrides,
  };
}

describe('deterministicTarget', () => {
  test('reactionTo matches an event by notifyMessageId', () => {
    const target = attention({ id: 'att-A', notifyMessageId: 'notify-A' });
    const other = attention({ id: 'att-B', notifyMessageId: 'notify-B' });
    const got = deterministicTarget(inbound({ reactionTo: 'notify-A' }), [target, other]);
    expect(got?.id).toBe('att-A');
  });

  test('explicit reactionTo matching 0 pending -> undefined (forces clarify, NOT singleton fallthrough)', () => {
    // The single pending event has a DIFFERENT notifyMessageId. An explicit but
    // unresolvable binding must never be coerced onto the lone pending event.
    const lone = attention({ id: 'att-only', notifyMessageId: 'notify-X' });
    const got = deterministicTarget(inbound({ reactionTo: 'notify-NOPE' }), [lone]);
    expect(got).toBeUndefined();
  });

  test('explicit reactionTo matching >1 pending -> undefined (ambiguous)', () => {
    const a = attention({ id: 'att-A', notifyMessageId: 'dupe' });
    const b = attention({ id: 'att-B', notifyMessageId: 'dupe' });
    const got = deterministicTarget(inbound({ reactionTo: 'dupe' }), [a, b]);
    expect(got).toBeUndefined();
  });

  test('exactly one pending, no binding -> returns that event', () => {
    const only = attention({ id: 'att-solo' });
    const got = deterministicTarget(inbound(), [only]);
    expect(got?.id).toBe('att-solo');
  });

  test('more than one pending, no binding -> undefined', () => {
    const a = attention({ id: 'att-A' });
    const b = attention({ id: 'att-B' });
    const got = deterministicTarget(inbound(), [a, b]);
    expect(got).toBeUndefined();
  });

  test('zero pending, no binding -> undefined', () => {
    expect(deterministicTarget(inbound(), [])).toBeUndefined();
  });
});

describe('isDestructiveTool', () => {
  test('file-edit tools are non-destructive', () => {
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(isDestructiveTool(t)).toBe(false);
    }
  });

  test('Bash / network / unknown / missing are destructive', () => {
    expect(isDestructiveTool('Bash')).toBe(true);
    expect(isDestructiveTool('WebFetch')).toBe(true);
    expect(isDestructiveTool('SomethingNew')).toBe(true);
    expect(isDestructiveTool(undefined)).toBe(true);
  });
});

describe('isPermissionAttention', () => {
  test('true only for PERMISSION kind', () => {
    expect(isPermissionAttention(attention({ kind: AttentionKind.PERMISSION }))).toBe(true);
    expect(isPermissionAttention(attention({ kind: AttentionKind.PLAN }))).toBe(false);
    expect(isPermissionAttention(attention({ kind: AttentionKind.QUESTION }))).toBe(false);
    expect(isPermissionAttention(attention({ kind: AttentionKind.IDLE }))).toBe(false);
    expect(isPermissionAttention(attention({ kind: AttentionKind.TURN_COMPLETE }))).toBe(false);
  });
});

describe('actionAllowedForKind — respond_to_request action↔kind gate', () => {
  test("approve is plans-only", () => {
    expect(actionAllowedForKind(RequestAction.APPROVE, AttentionKind.PLAN)).toBe(true);
    expect(actionAllowedForKind(RequestAction.APPROVE, AttentionKind.PERMISSION)).toBe(false);
    expect(actionAllowedForKind(RequestAction.APPROVE, AttentionKind.QUESTION)).toBe(false);
  });

  test("allow is permissions-only", () => {
    expect(actionAllowedForKind(RequestAction.ALLOW, AttentionKind.PERMISSION)).toBe(true);
    expect(actionAllowedForKind(RequestAction.ALLOW, AttentionKind.PLAN)).toBe(false);
    expect(actionAllowedForKind(RequestAction.ALLOW, AttentionKind.QUESTION)).toBe(false);
  });

  test('answer and deny apply to any pending kind', () => {
    for (const kind of [AttentionKind.PERMISSION, AttentionKind.QUESTION, AttentionKind.PLAN]) {
      expect(actionAllowedForKind(RequestAction.ANSWER, kind)).toBe(true);
      expect(actionAllowedForKind(RequestAction.DENY, kind)).toBe(true);
    }
  });

  test('an unrecognized action is rejected (fail-closed)', () => {
    expect(actionAllowedForKind('superuser' as RequestAction, AttentionKind.PERMISSION)).toBe(false);
  });
});
