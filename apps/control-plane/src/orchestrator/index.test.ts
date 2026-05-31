/**
 * Critical-path unit tests for the orchestrator's pure decision helpers
 * (Lane E, D5): grant-cap enforcement in validateAction and onboarding-token
 * extraction. Pure logic only — neither helper touches the DB/network, and
 * importing index.ts opens no connection (Pool/env are lazy).
 *
 * SAFETY focus: validateAction is the seam that enforces "the LLM can NEVER
 * mint a FULL grant" (Contract #1). A bug here lets a model auto-allow
 * everything while AFK.
 */
import { describe, expect, test } from 'bun:test';
import { GrantLevel } from '@imsg/shared';
import { LlmActionType } from './prompt.ts';
import { extractOnboardingToken, validateAction } from './index.ts';

describe('validateAction — grant cap (LLM may never set FULL)', () => {
  test("grant:'full' is capped to EDITS", () => {
    const a = validateAction({ type: LlmActionType.APPROVE_PLAN, grant: GrantLevel.FULL });
    expect(a?.grant).toBe(GrantLevel.EDITS);
  });

  test("grant:'off' is dropped (treated as no grant)", () => {
    const a = validateAction({ type: LlmActionType.APPROVE_PLAN, grant: GrantLevel.OFF });
    expect(a?.grant).toBeUndefined();
  });

  test("grant:'edits' is preserved", () => {
    const a = validateAction({ type: LlmActionType.APPROVE_PLAN, grant: GrantLevel.EDITS });
    expect(a?.grant).toBe(GrantLevel.EDITS);
  });

  test('an unrecognized grant value is dropped (not coerced to a grant)', () => {
    const a = validateAction({ type: LlmActionType.APPROVE_PLAN, grant: 'superuser' });
    expect(a?.grant).toBeUndefined();
  });

  test('missing grant stays undefined', () => {
    const a = validateAction({ type: LlmActionType.ALLOW });
    expect(a?.grant).toBeUndefined();
  });
});

describe('validateAction — type validation', () => {
  test('unknown action type -> undefined', () => {
    expect(validateAction({ type: 'launch_nukes' })).toBeUndefined();
  });

  test('missing/non-string type -> undefined', () => {
    expect(validateAction({})).toBeUndefined();
    expect(validateAction({ type: 42 } as unknown as Record<string, unknown>)).toBeUndefined();
  });

  test('undefined input -> undefined', () => {
    expect(validateAction(undefined)).toBeUndefined();
  });

  test('valid type with targetAttentionId + text is preserved', () => {
    const a = validateAction({
      type: LlmActionType.ANSWER,
      targetAttentionId: 'att-1',
      text: 'use postgres',
    });
    expect(a?.type).toBe(LlmActionType.ANSWER);
    expect(a?.targetAttentionId).toBe('att-1');
    expect(a?.text).toBe('use postgres');
  });

  test('empty-string targetAttentionId is not carried through', () => {
    const a = validateAction({ type: LlmActionType.ANSWER, targetAttentionId: '' });
    expect(a?.targetAttentionId).toBeUndefined();
  });
});

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
