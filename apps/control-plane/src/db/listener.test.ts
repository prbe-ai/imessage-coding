/**
 * Unit tests for waitForDelivered's control flow — the delivery-confirmation
 * primitive the orchestrator's 30s warn-only watcher parks on. Pure
 * timing/short-circuit logic only: the NOTIFY wake path needs a live Postgres
 * LISTEN client and is covered by the live deploy smoke, not here. Importing
 * listener.ts opens NO connection (ensureListener / loadEnv are lazy), so these
 * run offline.
 *
 * The invariant under test is PARK-BEFORE-QUERY: waitForDelivered must register
 * its waiter before the isDone() re-check, and must (a) short-circuit true when
 * isDone is already true, (b) time out false when not delivered and no NOTIFY
 * arrives, (c) treat a thrown isDone as not-yet-done (never a false "confirmed"),
 * and (d) honor a pre-aborted signal.
 */
import { describe, expect, test } from 'bun:test';
import { waitForDelivered } from './listener.ts';

// waitForDelivered calls ensureListener(); with no DATABASE_URL (the unit-test
// env) loadEnv throws synchronously and NOTHING connects, so these stay offline
// and hermetic — the ensureListener call resolves fast via settleWithin's catch.

describe('waitForDelivered — park-before-query + timeout semantics', () => {
  test('already delivered (isDone true) → resolves true without waiting', async () => {
    const start = Date.now();
    const ok = await waitForDelivered('row-1', 5_000, async () => true);
    expect(ok).toBe(true);
    // Short-circuited via the pre-check — nowhere near the 5s timeout.
    expect(Date.now() - start < 1_000).toBe(true);
  });

  test('not delivered, no NOTIFY → resolves false at the timeout', async () => {
    const start = Date.now();
    const ok = await waitForDelivered('row-2', 60, async () => false);
    expect(ok).toBe(false);
    expect(Date.now() - start >= 50).toBe(true);
  });

  test('isDone throws → treated as not-done, times out false (never throws)', async () => {
    const ok = await waitForDelivered('row-3', 60, async () => {
      throw new Error('transient db blip');
    });
    expect(ok).toBe(false);
  });

  test('pre-aborted signal → resolves false immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const ok = await waitForDelivered('row-4', 5_000, async () => false, ac.signal);
    expect(ok).toBe(false);
  });
});
