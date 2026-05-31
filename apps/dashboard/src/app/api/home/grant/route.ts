/**
 * POST /api/home/grant — set the standing grant level for the account's live
 * sessions. Same surface + sync model as /api/home/afk (the device reads the
 * `grant` column via the control plane's GET /api/device/state). Body:
 * `{ grant, sessionId? }`.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import { GrantLevel, SessionState, isGrantLevel } from "@imsg/shared";
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
  const { grant, sessionId } = (parsed ?? {}) as Partial<SetGrantRequest>;
  if (!isGrantLevel(grant)) {
    return NextResponse.json(
      {
        error: `grant must be one of: ${Object.values(GrantLevel).join(", ")}`,
      },
      { status: 422 },
    );
  }

  const res = sessionId
    ? await query(
        `UPDATE sessions SET "grant" = $1
          WHERE account_id = $2 AND id = $3 AND state <> $4`,
        [grant, ctx.accountId, sessionId, SessionState.ENDED],
      )
    : await query(
        `UPDATE sessions SET "grant" = $1
          WHERE account_id = $2 AND state <> $3`,
        [grant, ctx.accountId, SessionState.ENDED],
      );

  const body: SetGrantResponse = { grant, updated: res.rowCount ?? 0 };
  return NextResponse.json(body, { status: 200 });
}
