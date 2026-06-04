import { describe, expect, test } from 'bun:test';
import { acquireLease, type AcquireDeps } from './account-lock.ts';

/** A controllable clock: sleep() advances now() so the bounded wait terminates
 *  without real time passing. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** Build AcquireDeps around a `run` that yields the given row-arrays in order
 *  (last entry repeats once exhausted), or throws if `run` is an Error. */
function deps(
  run: AcquireDeps['run'],
  overrides: Partial<AcquireDeps> = {},
): AcquireDeps {
  const clock = fakeClock();
  return { run, sleep: clock.sleep, now: clock.now, timeoutMs: 1000, retryMs: 200, ...overrides };
}

describe('acquireLease — lease decision logic', () => {
  test('a returned row → we own it (acquired), no waiting', async () => {
    let calls = 0;
    const run: AcquireDeps['run'] = async () => {
      calls += 1;
      return [{ owner: 'me' }];
    };
    expect(await acquireLease('acct', 'tok', deps(run))).toBe(true);
    expect(calls).toBe(1); // acquired on the first attempt
  });

  test('zero rows = busy → retries, then acquires when the holder releases', async () => {
    const sequence: ReadonlyArray<unknown>[] = [[], [], [{ owner: 'me' }]];
    let i = 0;
    const run: AcquireDeps['run'] = async () => sequence[Math.min(i++, sequence.length - 1)]!;
    expect(await acquireLease('acct', 'tok', deps(run))).toBe(true);
    expect(i).toBe(3); // two busy reads, then success
  });

  test('still busy past the bounded window → false (proceed best-effort)', async () => {
    const run: AcquireDeps['run'] = async () => []; // never free
    expect(await acquireLease('acct', 'tok', deps(run, { timeoutMs: 600, retryMs: 200 }))).toBe(
      false,
    );
  });

  test('acquire query throws (DB blip) → false (proceed best-effort), no retry storm', async () => {
    let calls = 0;
    const run: AcquireDeps['run'] = async () => {
      calls += 1;
      throw new Error('connection reset');
    };
    expect(await acquireLease('acct', 'tok', deps(run))).toBe(false);
    expect(calls).toBe(1); // an error short-circuits — does not loop
  });

  test('passes account id + token to the query', async () => {
    let seen: unknown[] = [];
    const run: AcquireDeps['run'] = async (_text, params) => {
      seen = params;
      return [{ owner: 'me' }];
    };
    await acquireLease('acct-123', 'token-abc', deps(run));
    expect(seen[0]).toBe('acct-123');
    expect(seen[1]).toBe('token-abc');
  });
});
