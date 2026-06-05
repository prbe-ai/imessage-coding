/**
 * Server-side mapping of `devices` DB rows to the shared `DeviceInfo` wire
 * shape. AFK is MACHINE-WIDE (the PreToolUse hook reads one shared state file
 * per machine), so it lives on the device, not the session. Mirrors
 * lib/sessions.ts; the column CHECK constraints in db/schema.sql keep DB values
 * valid enum members, so the validators here are defense-in-depth.
 *
 * Server-only.
 */

import "server-only";

import { AfkState, isAfkState, type DeviceInfo } from "@imsg/shared";
import { query } from "@/lib/db";

/** Raw shape selected from `devices` (+ a live-session count). */
export interface DeviceDbRow {
  id: string;
  os: string | null;
  hostname: string | null;
  afk: string;
  enabled: boolean;
  session_count: string | number;
}

/** Convert a DB row to the shared `DeviceInfo`, clamping any unexpected enum
 *  value to its safe default (never throws). Label = hostname → os → short id. */
export function toDeviceInfo(row: DeviceDbRow): DeviceInfo {
  const label = row.hostname?.trim() || row.os?.trim() || row.id.slice(0, 8);
  const info: DeviceInfo = {
    id: row.id,
    label,
    afk: isAfkState(row.afk) ? row.afk : AfkState.OFF,
    enabled: row.enabled,
    sessionCount: Number(row.session_count),
  };
  if (row.os) info.os = row.os;
  if (row.hostname) info.hostname = row.hostname;
  return info;
}

/** Columns + live-session count backing a DeviceInfo. Shared by the list route
 *  so the SELECT and the mapper can't drift. `d` is the devices alias. */
export const DEVICE_COLUMNS =
  'd.id, d.os, d.hostname, d.afk, ' +
  "(d.revoked_at IS NULL AND d.disabled_at IS NULL) AS enabled, " +
  "(SELECT count(*) FROM sessions s WHERE s.device_id = d.id AND s.state <> 'ended') " +
  "AS session_count";

/** Whether the account has paired at least one still-valid (non-revoked)
 *  device. A number is `verified` the moment the user confirms it — before any
 *  device exists — so "fully onboarded" requires both. This is a cheaper,
 *  broader probe than the home device list (which is gated on a live session):
 *  it counts any paired machine, online or not. */
export async function accountHasDevice(accountId: string): Promise<boolean> {
  const res = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM devices
        WHERE account_id = $1 AND revoked_at IS NULL
     ) AS exists`,
    [accountId],
  );
  return Boolean(res.rows[0]?.exists);
}
