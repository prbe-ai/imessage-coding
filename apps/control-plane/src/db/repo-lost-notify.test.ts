import { describe, expect, test } from 'bun:test';
import {
  claimDevicesToNotifyLost,
  DEVICE_CONVERSATION_ACTIVE_SECONDS,
  DEVICE_OFFLINE_NOTIFY_SECONDS,
  type ClaimRun,
} from './repo.ts';

/** A fake DB executor that records the (sql, params) it was called with and
 *  returns canned rows — the account-lock.ts `run`-seam pattern, so the JS half
 *  of the claim (param wiring, afk gate, row mapping) is testable without a live
 *  Postgres. The SQL conversation-relock semantics themselves are smoke-tested
 *  against a throwaway Neon branch, the same way the other repo.ts SQL is verified. */
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

describe('claimDevicesToNotifyLost — conversation-relock wiring + afk gate', () => {
  test('threads offline-debounce + conversation-active as $1/$2 (defaults)', async () => {
    const { run, calls } = recordingRun([]);
    await claimDevicesToNotifyLost(undefined, undefined, run);
    expect(calls.length).toBe(1);
    expect(calls[0]!.params).toEqual([
      DEVICE_OFFLINE_NOTIFY_SECONDS,
      DEVICE_CONVERSATION_ACTIVE_SECONDS,
    ]);
  });

  test('a custom window pair threads through unchanged', async () => {
    const { run, calls } = recordingRun([]);
    await claimDevicesToNotifyLost(90, 45, run);
    expect(calls[0]!.params).toEqual([90, 45]);
  });

  test('SQL encodes conversation-relock (lock + re-arm-on-inbound + active suppress)', async () => {
    const { run, calls } = recordingRun([]);
    await claimDevicesToNotifyLost(undefined, undefined, run);
    const sql = calls[0]!.text;
    // Claiming LOCKS the device (stamps the last-notified time).
    expect(sql.includes('SET lost_notified_at = now()')).toBe(true);
    // Only a device that was in use (has sessions) is eligible.
    expect(sql.includes('EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = d.id)')).toBe(true);
    // OFFLINE past the debounce ($1): no session beat recently.
    expect(sql.includes("s.last_event_at >= now() - ($1::int * interval '1 second')")).toBe(true);
    // ARMED: never notified, OR the user re-engaged (an inbound newer than the lock).
    expect(sql.includes('d.lost_notified_at IS NULL')).toBe(true);
    expect(sql.includes('m.created_at > d.lost_notified_at')).toBe(true);
    // SUPPRESS while mid-conversation ($2): an inbound within the active window.
    expect(sql.includes("m.created_at >= now() - ($2::int * interval '1 second')")).toBe(true);
    // Re-arm + suppression are keyed on USER messages (inbound), account-scoped.
    expect(sql.includes("m.direction = 'inbound'")).toBe(true);
    expect(sql.includes('message_log m')).toBe(true);
    expect(sql.includes('m.account_id = d.account_id')).toBe(true);
    // afk gate is on the RETURN, not the claim.
    expect(sql.includes("(d.afk = 'on') AS notify")).toBe(true);
  });

  test('only afk=on devices are RETURNED (afk=off are locked-but-silent)', async () => {
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
