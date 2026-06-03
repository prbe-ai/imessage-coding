/**
 * Unit tests for the BLOCKING approve-and-resume PURE helpers (routes/permission.ts).
 *
 * What's pure (and tested here): the deadline→explicit-deny shaping, the
 * verdict→response shaping (allow→allow, deny→deny, fail-closed widening), and
 * the deadline-must-be-strictly-less-than-the-hook-timeout invariant. No DB, no
 * network — importing permission.ts opens no connection.
 *
 * INTEGRATION-TEST GAP (noted, not faked): the surface→wait→verdict/deadline
 * round-trip in routes/device.ts touches Postgres (insertAttentionEvent,
 * findVerdictForRequest) and the LISTEN/NOTIFY waiter, and the repo has no
 * DB-backed test harness. That path — a tap-back resolving the attention through
 * the UNCHANGED orchestrator/safety.ts gate, the verdict row waking the session
 * waiter, and the deadline firing a clean deny — needs a live deploy smoke
 * (mirrors how listener.ts's NOTIFY wake is covered by the deploy smoke, not here).
 */
import { describe, expect, test } from 'bun:test';
import { DecisionBehavior } from '@imsg/shared';
import {
  CODEX_HOOK_TIMEOUT_MS,
  PERMISSION_DEADLINE_MS,
  assertDeadlineBelowHookTimeout,
  deadlineDenyResponse,
  verdictResponse,
} from './permission.ts';

describe('deadlineDenyResponse — timeout is a clean deny, never a fall-through', () => {
  test('returns an EXPLICIT deny with a reason (never allow)', () => {
    const r = deadlineDenyResponse();
    expect(r.behavior).toBe(DecisionBehavior.DENY);
    expect(r.reason).toBe('approval deadline');
  });

  test('never returns allow on the deadline path', () => {
    expect(deadlineDenyResponse().behavior).not.toBe(DecisionBehavior.ALLOW);
  });
});

describe('verdictResponse — allow→allow, deny→deny, fail-closed widening', () => {
  test('verdict allow → allow', () => {
    expect(verdictResponse(DecisionBehavior.ALLOW)).toEqual({ behavior: DecisionBehavior.ALLOW });
  });

  test('verdict deny → deny', () => {
    expect(verdictResponse(DecisionBehavior.DENY)).toEqual({ behavior: DecisionBehavior.DENY });
  });

  test('a non-ALLOW value is coerced to deny (fail-closed — never widens to allow)', () => {
    // A malformed/unexpected behavior must never resume a destructive command.
    expect(verdictResponse('something-else' as DecisionBehavior)).toEqual({
      behavior: DecisionBehavior.DENY,
    });
  });
});

describe('deadline invariant — server deadline MUST be < the Codex hook timeout', () => {
  test('the shipped constants satisfy the relationship', () => {
    expect(PERMISSION_DEADLINE_MS < CODEX_HOOK_TIMEOUT_MS).toBe(true);
  });

  test('assertDeadlineBelowHookTimeout passes for the shipped constants and returns the deadline', () => {
    expect(assertDeadlineBelowHookTimeout()).toBe(PERMISSION_DEADLINE_MS);
  });

  test('a deadline equal to the hook timeout throws (must be STRICTLY less)', () => {
    expect(() => assertDeadlineBelowHookTimeout(1_000, 1_000)).toThrow(/strictly less/);
  });

  test('a deadline greater than the hook timeout throws (would fall through to the local prompt)', () => {
    expect(() => assertDeadlineBelowHookTimeout(2_000, 1_000)).toThrow(/unattended local prompt/);
  });

  test('a deadline strictly below the hook timeout passes and returns it', () => {
    expect(assertDeadlineBelowHookTimeout(999, 1_000)).toBe(999);
  });

  test('there is comfortable headroom (deadline ≤ 90% of the hook timeout) for the round-trip', () => {
    // Not a hard requirement of the invariant, but a regression guard: a deadline
    // crammed right up against the hook timeout leaves no slack for the network
    // round-trip back to the hook before it lapses.
    expect(PERMISSION_DEADLINE_MS).toBeLessThanOrEqual(CODEX_HOOK_TIMEOUT_MS * 0.9);
  });
});
