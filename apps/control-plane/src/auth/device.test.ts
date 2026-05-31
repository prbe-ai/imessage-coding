/**
 * Critical-path unit tests for device-token hashing (Lane E, D5).
 *
 * hashToken is the seam that guarantees we NEVER store a raw device/pairing
 * token: the DB holds a peppered SHA-256 hash. A bug that drops the pepper (or
 * is non-deterministic) breaks auth or makes a DB leak forgeable.
 *
 * Pure logic — no DB/network. hashToken reads the pepper via loadEnv(), which
 * also requires DATABASE_URL; both are set here BEFORE the first call. loadEnv()
 * memoizes, so we assert determinism + pepper-sensitivity by reproducing the
 * exact HMAC construction (createHmac('sha256', pepper).update(token)) and
 * confirming a different pepper yields a different digest.
 */
import { createHmac } from 'node:crypto';

const PEPPER = 'test-device-pepper-9f8e7d';

// Must be set before loadEnv() runs (lazy + memoized). hashToken triggers it.
process.env['DEVICE_TOKEN_PEPPER'] = PEPPER;
// loadEnv() also require_'s DATABASE_URL; supply a dummy (never connected).
process.env['DATABASE_URL'] ??= 'postgres://test:test@localhost:5432/test';

import { describe, expect, test } from 'bun:test';
import { hashToken } from './device.ts';

/** Reproduce the impl's exact construction for cross-checking. */
function pepperedHash(pepper: string, token: string): string {
  return createHmac('sha256', pepper).update(token).digest('hex');
}

describe('hashToken', () => {
  test('same input -> same peppered hash (deterministic)', () => {
    const token = 'raw-device-token-abc';
    expect(hashToken(token)).toBe(hashToken(token));
  });

  test('hashToken matches HMAC-SHA256(pepper, token) — pepper is actually mixed in', () => {
    const token = 'raw-device-token-abc';
    expect(hashToken(token)).toBe(pepperedHash(PEPPER, token));
  });

  test('output is a 64-char hex SHA-256 digest', () => {
    expect(hashToken('whatever')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different tokens -> different hashes', () => {
    expect(hashToken('token-one')).not.toBe(hashToken('token-two'));
  });

  test('different pepper -> different hash (a leaked DB row is not forgeable without the pepper)', () => {
    const token = 'raw-device-token-abc';
    const withConfiguredPepper = hashToken(token); // == pepperedHash(PEPPER, token)
    const withOtherPepper = pepperedHash('a-totally-different-pepper', token);
    expect(withOtherPepper).not.toBe(withConfiguredPepper);
  });
});
