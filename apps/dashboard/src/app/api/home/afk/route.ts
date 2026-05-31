/**
 * POST /api/home/afk — toggle AFK for the account's live sessions.
 *
 * Writes `sessions.afk` directly in the shared Neon DB (account-scoped). The
 * device plugin reads its AFK/grant from the control plane's
 * GET /api/device/state, which reads the same column — so a dashboard toggle
 * syncs to the device on its next state poll. Body: `{ afk, sessionId? }`;
 * omitting `sessionId` applies to every non-ended session on the account.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import { AfkState, SessionState, isAfkState } from "@imsg/shared";
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
  const { afk, sessionId } = (parsed ?? {}) as Partial<SetAfkRequest>;
  if (!isAfkState(afk)) {
    return NextResponse.json(
      { error: `afk must be one of: ${Object.values(AfkState).join(", ")}` },
      { status: 422 },
    );
  }

  // Scope to one session when given; otherwise every live session. Either way
  // the account_id predicate is the tenant boundary.
  const res = sessionId
    ? await query(
        `UPDATE sessions SET afk = $1
          WHERE account_id = $2 AND id = $3 AND state <> $4`,
        [afk, ctx.accountId, sessionId, SessionState.ENDED],
      )
    : await query(
        `UPDATE sessions SET afk = $1
          WHERE account_id = $2 AND state <> $3`,
        [afk, ctx.accountId, SessionState.ENDED],
      );

  const body: SetAfkResponse = { afk, updated: res.rowCount ?? 0 };
  return NextResponse.json(body, { status: 200 });
}
