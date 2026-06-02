/**
 * Critical-path unit tests for the orchestrator's pure helpers: grant-cap
 * enforcement (capGrant) and onboarding-token extraction. Pure logic only —
 * neither helper touches the DB/network, and importing index.ts opens no
 * connection (Pool/env are lazy).
 *
 * SAFETY focus: capGrant is the seam that enforces "the LLM can NEVER mint a
 * FULL grant" (Contract #1). A bug here lets a model auto-allow everything while
 * the user is AFK. (It replaces the old validateAction grant cap after the
 * orchestrator moved to tool-calling — the cap is now applied in the
 * respond_to_request handler (action='approve') via this function.)
 */
import { describe, expect, test } from 'bun:test';
import { GrantLevel } from '@imsg/shared';
import { capGrant, extractOnboardingToken } from './index.ts';

describe('capGrant — LLM may never set FULL', () => {
  test("'full' is capped to EDITS", () => {
    expect(capGrant(GrantLevel.FULL)).toBe(GrantLevel.EDITS);
  });

  test("'off' is dropped (treated as no grant)", () => {
    expect(capGrant(GrantLevel.OFF)).toBeUndefined();
  });

  test("'edits' is preserved", () => {
    expect(capGrant(GrantLevel.EDITS)).toBe(GrantLevel.EDITS);
  });

  test('an unrecognized grant value is dropped (not coerced to a grant)', () => {
    expect(capGrant('superuser')).toBeUndefined();
  });

  test('missing / non-string grant stays undefined', () => {
    expect(capGrant(undefined)).toBeUndefined();
    expect(capGrant(42 as unknown)).toBeUndefined();
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
