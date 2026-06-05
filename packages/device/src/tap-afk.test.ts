/**
 * Unit tests for the tap's ephemeral AFK-gated mirror decision (classifyAfkTick).
 *
 * Pins the data-lifecycle invariants the user asked for: upload ONLY while AFK,
 * backfill the whole session when AFK turns on, discard the queue when it turns off
 * (the server wipes the DB then).
 */
import { describe, expect, test } from 'bun:test';
import { classifyAfkTick } from './tap-afk.ts';

describe('classifyAfkTick', () => {
  test('not AFK → never ships, never backfills', () => {
    expect(classifyAfkTick(false, false, true)).toEqual({
      shipping: false,
      shouldBackfill: false,
      shouldClearOutbox: false,
    });
  });

  test('off→on edge (egress on) → ship + backfill the full session', () => {
    expect(classifyAfkTick(false, true, true)).toEqual({
      shipping: true,
      shouldBackfill: true,
      shouldClearOutbox: false,
    });
  });

  test('steady AFK on → ship incrementally, no backfill', () => {
    expect(classifyAfkTick(true, true, true)).toEqual({
      shipping: true,
      shouldBackfill: false,
      shouldClearOutbox: false,
    });
  });

  test('on→off edge → stop shipping, clear the outbox (server wipes the DB)', () => {
    expect(classifyAfkTick(true, false, true)).toEqual({
      shipping: false,
      shouldBackfill: false,
      shouldClearOutbox: true,
    });
  });

  test('AFK on but killswitched (egress off) → no ship, no backfill yet', () => {
    // lastAfk stays false until egress returns, so the backfill fires on the first
    // ENABLED afk tick — not skipped.
    expect(classifyAfkTick(false, true, false)).toEqual({
      shipping: false,
      shouldBackfill: false,
      shouldClearOutbox: false,
    });
  });

  test('killswitch returns while AFK → backfill fires on that first enabled tick', () => {
    expect(classifyAfkTick(false, true, true).shouldBackfill).toBe(true);
  });

  test('on→off while killswitched still clears the outbox', () => {
    expect(classifyAfkTick(true, false, false).shouldClearOutbox).toBe(true);
  });
});
