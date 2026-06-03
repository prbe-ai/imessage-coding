/**
 * GET /api/home/devices — the account's paired (non-revoked) devices.
 *
 * AFK is MACHINE-WIDE, so it lives on the device, not the session — the
 * dashboard groups sessions under their device and exposes one AFK switch per
 * device. Reads the shared Neon DB directly (account-scoped), mirroring the
 * control plane's listDevicesForAccount.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import { DEVICE_COLUMNS, toDeviceInfo, type DeviceDbRow } from "@/lib/devices";
import type { DevicesResponse } from "@/lib/api/contracts";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const ctx = await requireAccount(req);
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Only ACTIVE devices (≥1 live session): keeps the list to machines worth
  // toggling and collapses stale re-pair duplicates (which carry no sessions).
  const res = await query<DeviceDbRow>(
    `SELECT ${DEVICE_COLUMNS}
       FROM devices d
      WHERE d.account_id = $1 AND d.revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.state <> 'ended'
        )
      ORDER BY (
        SELECT max(last_event_at) FROM sessions s WHERE s.device_id = d.id
      ) DESC NULLS LAST, d.paired_at DESC`,
    [ctx.accountId],
  );

  const body: DevicesResponse = { devices: res.rows.map(toDeviceInfo) };
  return NextResponse.json(body, { status: 200 });
}
