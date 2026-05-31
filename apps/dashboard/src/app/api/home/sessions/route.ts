/**
 * GET /api/home/sessions — live, account-scoped Claude Code sessions.
 *
 * The dashboard and control plane share one Neon database, so this reads the
 * `sessions` table directly (account-scoped) and maps rows to the shared
 * `SessionInfo`. Ended sessions are excluded; the most recently active
 * sessions come first. Mirrors the read the control plane exposes to devices
 * but on the user-auth (Better Auth cookie) side.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import { SessionState } from "@imsg/shared";
import { toSessionInfo, type SessionDbRow } from "@/lib/sessions";
import type { SessionsResponse } from "@/lib/api/contracts";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const ctx = await requireAccount(req);
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const res = await query<SessionDbRow>(
    `SELECT id, device_id, cwd, agent, last_event_at, state, afk, grant
       FROM sessions
      WHERE account_id = $1 AND state <> $2
      ORDER BY last_event_at DESC`,
    [ctx.accountId, SessionState.ENDED],
  );

  const body: SessionsResponse = { sessions: res.rows.map(toSessionInfo) };
  return NextResponse.json(body, { status: 200 });
}
