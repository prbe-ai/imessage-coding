import { describe, expect, test } from 'bun:test';
import {
  claimDevicesToNotifyLost,
  DEVICE_OFFLINE_SUSTAIN_SECONDS,
  DEVICE_ONLINE_SUSTAIN_SECONDS,
  markDevicesOnline,
  SESSION_STALE_SECONDS,
  type ClaimRun,
} from './repo.ts';

/** A fake DB executor that records the (sql, params) it was called with and
 *  returns canned rows — the account-lock.ts `run`-seam pattern, so the JS half
 *  of the claim (param wiring, afk gate, row mapping) is testable without a live
 *  Postgres. The SQL hysteresis semantics themselves are smoke-tested against a
 *  throwaway Neon branch, the same way the other repo.ts SQL is verified. */
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

describe('claimDevicesToNotifyLost — hysteresis wiring + afk gate', () => {
  test('threads offline-sustain + online-sustain as $1/$2 (defaults)', async () => {
    const { run, calls } = recordingRun([]);
    await claimDevicesToNotifyLost(undefined, undefined, run);
    expect(calls.length).toBe(1);
    expect(calls[0]!.params).toEqual([
      DEVICE_OFFLINE_SUSTAIN_SECONDS,
      DEVICE_ONLINE_SUSTAIN_SECONDS,
    ]);
  });

  test('a custom window pair threads through unchanged', async () => {
    const { run, calls } = recordingRun([]);
    await claimDevicesToNotifyLost(120, 90, run);
    expect(calls[0]!.params).toEqual([120, 90]);
  });

  test('SQL encodes the hysteresis state machine (not a cooldown)', async () => {
    const { run, calls } = recordingRun([]);
    await claimDevicesToNotifyLost(undefined, undefined, run);
    const sql = calls[0]!.text;
    // Only devices with an OPEN streak are eligible — selected in the CTE...
    expect(sql.includes('d.online_since IS NOT NULL')).toBe(true);
    // ...and re-checked at row-lock time so only one instance consumes a streak.
    expect((sql.match(/online_since IS NOT NULL/g) ?? []).length).toBe(2);
    // Every claimed device CONSUMES its streak (reset the state machine)...
    expect(sql.includes('online_since = NULL')).toBe(true);
    // ...but lost_notified_at is only stamped on a genuine (sustained) alert.
    expect(sql.includes('CASE WHEN o.sustained_online THEN now()')).toBe(true);
    // SUSTAINED-ONLINE: a beat landed >= online_since + the online-sustain window ($2).
    expect(sql.includes("d.online_since + ($2::int * interval '1 second')")).toBe(true);
    // SUSTAINED-OFFLINE: no beat within the offline-sustain window ($1).
    expect(sql.includes("now() - ($1::int * interval '1 second')")).toBe(true);
    // The notice fires only for an afk=on device whose streak was sustained.
    expect(sql.includes('(o.afk_on AND o.sustained_online) AS notify')).toBe(true);
    // The old cooldown gating is gone.
    expect(sql.includes('lost_notified_at IS NULL')).toBe(false);
  });

  test('only afk=on devices are RETURNED (afk=off are consumed-but-silent)', async () => {
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
    const out = await claimDevicesToNotifyLost(undefined, undefined, run);
    expect(out).toEqual([
      { id: 'd-afk-on', accountId: 'acct-1', hostname: 'Manavs-MacBook-Pro.local', os: 'darwin' },
    ]);
  });

  test('maps snake_case row → LostDevice and drops the notify flag', async () => {
    const { run } = recordingRun([
      { id: 'd1', account_id: 'a1', hostname: 'h1', os: 'o1', notify: true },
    ]);
    const out = await claimDevicesToNotifyLost(undefined, undefined, run);
    expect(out).toEqual([{ id: 'd1', accountId: 'a1', hostname: 'h1', os: 'o1' }]);
    // Exact key set proves the snake_case `account_id` and the `notify` flag are dropped.
    expect(Object.keys(out[0]!)).toEqual(['id', 'accountId', 'hostname', 'os']);
  });

  test('no claimed devices → empty array', async () => {
    const { run } = recordingRun([]);
    expect(await claimDevicesToNotifyLost(undefined, undefined, run)).toEqual([]);
  });
});

describe('markDevicesOnline — "came online" edge', () => {
  test('threads the stale window as $1 (default)', async () => {
    const { run, calls } = recordingRun([]);
    await markDevicesOnline(undefined, run);
    expect(calls.length).toBe(1);
    expect(calls[0]!.params).toEqual([SESSION_STALE_SECONDS]);
  });

  test('a custom stale window threads through unchanged', async () => {
    const { run, calls } = recordingRun([]);
    await markDevicesOnline(15, run);
    expect(calls[0]!.params).toEqual([15]);
  });

  test('SQL stamps only NULL streaks on a currently-beating device (idempotent)', async () => {
    const { run, calls } = recordingRun([]);
    await markDevicesOnline(undefined, run);
    const sql = calls[0]!.text;
    expect(sql.includes('SET online_since = now()')).toBe(true);
    // Idempotent + stable: never bumps an existing streak start.
    expect(sql.includes('d.online_since IS NULL')).toBe(true);
    // Only a device beating within the stale window is "online".
    expect(sql.includes("now() - ($1::int * interval '1 second')")).toBe(true);
    // Never resurrects a revoked/disabled device.
    expect(sql.includes('d.revoked_at IS NULL')).toBe(true);
    expect(sql.includes('d.disabled_at IS NULL')).toBe(true);
  });
});
