/**
 * POST /api/home/grant — set the machine-wide standing grant level.
 *
 * Grant is per-DEVICE (same shared-hook-file reason as AFK), so this writes
 * `devices.grant` (account-scoped); the device picks it up via the `device_state`
 * trigger → SSE `state`. Body: `{ grant, deviceId? }`; omitting `deviceId`
 * applies to every device on the account.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import { GrantLevel, isGrantLevel } from "@imsg/shared";
import type { SetGrantRequest, SetGrantResponse } from "@/lib/api/contracts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const ctx = await requireAccount(req);
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { grant, deviceId } = (parsed ?? {}) as Partial<SetGrantRequest>;
  if (!isGrantLevel(grant)) {
    return NextResponse.json(
      {
        error: `grant must be one of: ${Object.values(GrantLevel).join(", ")}`,
      },
      { status: 422 },
    );
  }

  const res = deviceId
    ? await query(
        `UPDATE devices SET "grant" = $1 WHERE account_id = $2 AND id = $3`,
        [grant, ctx.accountId, deviceId],
      )
    : await query(`UPDATE devices SET "grant" = $1 WHERE account_id = $2`, [
        grant,
        ctx.accountId,
      ]);

  const body: SetGrantResponse = { grant, updated: res.rowCount ?? 0 };
  return NextResponse.json(body, { status: 200 });
}
