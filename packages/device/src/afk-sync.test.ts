/**
 * Unit tests for the AFK dirty-flag sync decisions.
 *
 * Covers the two bugs WS3 fixes:
 *   1. the REVERT RACE (eng-review's mandatory regression) — a failed /afk POST
 *      followed by a new session's SSE flush must NOT revert the local toggle;
 *   2. the lost POST self-heal — the heartbeat re-asserts the dirty value and only
 *      clears the flag once the server echoes the same afk back.
 */
import { describe, expect, test } from 'bun:test';
import { AfkState } from '@imsg/shared';
import { shouldAdoptDownstreamAfk, shouldClearDirty } from './afk-sync.ts';

describe('shouldAdoptDownstreamAfk (down-sync)', () => {
  test('clean device adopts a changed server value (dashboard toggle reaches the hook)', () => {
    expect(
      shouldAdoptDownstreamAfk({ pushedAfk: AfkState.ON, dirty: false, localAfk: AfkState.OFF }),
    ).toBe(true);
  });

  test('REGRESSION: a dirty local toggle is NOT reverted by a stale server push', () => {
    // Device toggled ON locally (POST lost → dirty), server still says OFF and pushes
    // it on a new session's first SSE flush. Must NOT overwrite the local ON.
    expect(
      shouldAdoptDownstreamAfk({ pushedAfk: AfkState.OFF, dirty: true, localAfk: AfkState.ON }),
    ).toBe(false);
  });

  test('no-op when the pushed value already matches local', () => {
    expect(
      shouldAdoptDownstreamAfk({ pushedAfk: AfkState.ON, dirty: false, localAfk: AfkState.ON }),
    ).toBe(false);
  });

  test('ignores a missing/garbage pushed value', () => {
    expect(shouldAdoptDownstreamAfk({ pushedAfk: undefined, dirty: false, localAfk: AfkState.OFF })).toBe(
      false,
    );
    expect(shouldAdoptDownstreamAfk({ pushedAfk: 'banana', dirty: false, localAfk: AfkState.OFF })).toBe(
      false,
    );
  });
});

describe('shouldClearDirty (up-sync confirm)', () => {
  test('clears once the server echoes the asserted afk back', () => {
    expect(
      shouldClearDirty({ wasDirty: true, success: true, echoAfk: AfkState.ON, localAfk: AfkState.ON }),
    ).toBe(true);
  });

  test('stays dirty if the POST failed (heartbeat retries next beat)', () => {
    expect(
      shouldClearDirty({ wasDirty: true, success: false, echoAfk: AfkState.ON, localAfk: AfkState.ON }),
    ).toBe(false);
  });

  test('stays dirty if the echo does not match what we asserted', () => {
    expect(
      shouldClearDirty({ wasDirty: true, success: true, echoAfk: AfkState.OFF, localAfk: AfkState.ON }),
    ).toBe(false);
  });

  test('stays dirty if the server returned no afk (non-dirty heartbeat path)', () => {
    expect(
      shouldClearDirty({ wasDirty: true, success: true, echoAfk: undefined, localAfk: AfkState.ON }),
    ).toBe(false);
  });

  test('not dirty to begin with → nothing to clear', () => {
    expect(
      shouldClearDirty({ wasDirty: false, success: true, echoAfk: AfkState.ON, localAfk: AfkState.ON }),
    ).toBe(false);
  });
});
