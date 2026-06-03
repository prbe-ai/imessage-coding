/**
 * POST /api/home/afk — set machine-wide AFK.
 *
 * AFK is per-DEVICE (the PreToolUse hook reads one shared afk.state file per
 * machine), so this writes `devices.afk` in the shared Neon DB (account-scoped).
 * The device's `device_state` trigger then wakes every live SSE stream for that
 * device → each mirrors the new value into its hook. Body: `{ afk, deviceId? }`;
 * omitting `deviceId` applies to every device on the account (the master toggle).
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import { AfkState, isAfkState } from "@imsg/shared";
import type { SetAfkRequest, SetAfkResponse } from "@/lib/api/contracts";

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
  const { afk, deviceId } = (parsed ?? {}) as Partial<SetAfkRequest>;
  if (!isAfkState(afk)) {
    return NextResponse.json(
      { error: `afk must be one of: ${Object.values(AfkState).join(", ")}` },
      { status: 422 },
    );
  }

  // Scope to one device when given; otherwise every device on the account. The
  // account_id predicate is the tenant boundary in both branches.
  const res = deviceId
    ? await query(
        `UPDATE devices SET afk = $1 WHERE account_id = $2 AND id = $3`,
        [afk, ctx.accountId, deviceId],
      )
    : await query(`UPDATE devices SET afk = $1 WHERE account_id = $2`, [
        afk,
        ctx.accountId,
      ]);

  const body: SetAfkResponse = { afk, updated: res.rowCount ?? 0 };
  return NextResponse.json(body, { status: 200 });
}
