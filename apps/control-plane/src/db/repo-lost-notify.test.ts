import { describe, expect, test } from 'bun:test';
import {
  claimDevicesToNotifyLost,
  DEVICE_LOST_NOTIFY_COOLDOWN_SECONDS,
  DEVICE_LOST_NOTIFY_GRACE_SECONDS,
  SESSION_STALE_SECONDS,
  type ClaimRun,
} from './repo.ts';

/** A fake DB executor that records the (sql, params) it was called with and
 *  returns canned rows — the account-lock.ts `run`-seam pattern, so the JS half
 *  of the claim (param wiring, afk gate, row mapping) is testable without a live
 *  Postgres. The SQL cooldown semantics themselves are verified against a Neon
 *  branch, the same way the other repo.ts SQL is smoke-tested. */
type ClaimRow = {
  id: string;
  account_id: string;
  hostname: string | null;
  os: string | null;
  notify: boolean;
};
function recordingRun(rows: ReadonlyArray<ClaimRow>): {
  run: ClaimRun;
  calls: { text: string; params: ReadonlyArray<unknown> }[];
} {
  const calls: { text: string; params: ReadonlyArray<unknown> }[] = [];
  const run: ClaimRun = async (text, params) => {
    calls.push({ text, params });
    return rows;
  };
  return { run, calls };
}

describe('claimDevicesToNotifyLost — cooldown wiring + afk gate', () => {
  test('threads grace, stale, and cooldown through as $1/$2/$3 (defaults)', async () => {
    const { run, calls } = recordingRun([]);
    await claimDevicesToNotifyLost(undefined, undefined, undefined, run);
    expect(calls.length).toBe(1);
    expect(calls[0]!.params).toEqual([
      DEVICE_LOST_NOTIFY_GRACE_SECONDS,
      SESSION_STALE_SECONDS,
      DEVICE_LOST_NOTIFY_COOLDOWN_SECONDS,
    ]);
  });

  test('re-arms on reconnect+cooldown, NOT on "stamp IS NULL" or cooldown alone', async () => {
    const { run, calls } = recordingRun([]);
    await claimDevicesToNotifyLost(undefined, undefined, undefined, run);
    const sql = calls[0]!.text;
    // Eligible when never claimed OR (the last claim is older than the cooldown AND
    // the device reconnected since — a session beat after the stamp). Both halves
    // matter: the cooldown rate-limits a FLAPPING machine; the reconnect check stops
    // a machine that just STAYS dropped from re-firing every cooldown forever.
    expect(sql.includes('d.lost_notified_at IS NULL')).toBe(true);
    expect(sql.includes('d.lost_notified_at < now() - ($3::int * interval')).toBe(true);
    expect(sql.includes('s.last_event_at > d.lost_notified_at')).toBe(true);
    // Guard the int-cast regression (Postgres 42725): operands cast, not the sum.
    expect(sql.includes('($1::int + $2::int)')).toBe(true);
  });

  test('a custom cooldown threads through unchanged', async () => {
    const { run, calls } = recordingRun([]);
    await claimDevicesToNotifyLost(45, 30, 600, run);
    expect(calls[0]!.params).toEqual([45, 30, 600]);
  });

  test('only afk=on devices are RETURNED (afk=off are claimed-but-silent)', async () => {
    const { run } = recordingRun([
      {
        id: 'd-afk-on',
        account_id: 'acct-1',
        hostname: 'Manavs-MacBook-Pro.local',
        os: 'darwin',
        notify: true,
      },
      {
        id: 'd-afk-off',
        account_id: 'acct-2',
        hostname: 'At-Keyboard.local',
        os: 'darwin',
        notify: false,
      },
    ]);
    const out = await claimDevicesToNotifyLost(undefined, undefined, undefined, run);
    expect(out).toEqual([
      { id: 'd-afk-on', accountId: 'acct-1', hostname: 'Manavs-MacBook-Pro.local', os: 'darwin' },
    ]);
  });

  test('maps snake_case row → LostDevice and drops the notify flag', async () => {
    const { run } = recordingRun([
      { id: 'd1', account_id: 'a1', hostname: 'h1', os: 'o1', notify: true },
    ]);
    const out = await claimDevicesToNotifyLost(undefined, undefined, undefined, run);
    expect(out).toEqual([{ id: 'd1', accountId: 'a1', hostname: 'h1', os: 'o1' }]);
    // Exact key set proves the snake_case `account_id` and the `notify` flag are dropped.
    expect(Object.keys(out[0]!)).toEqual(['id', 'accountId', 'hostname', 'os']);
  });

  test('no claimed devices → empty array', async () => {
    const { run } = recordingRun([]);
    expect(await claimDevicesToNotifyLost(undefined, undefined, undefined, run)).toEqual([]);
  });
});
