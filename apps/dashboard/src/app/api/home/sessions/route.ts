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

  // afk is machine-wide → source it from the session's device (JOIN),
  // not the now-unused sessions.afk column.
  const res = await query<SessionDbRow>(
    `SELECT s.id, s.device_id, s.cwd, s.title, s.agent, s.last_event_at,
            s.state, d.afk
       FROM sessions s
       JOIN devices d ON d.id = s.device_id
      WHERE s.account_id = $1 AND s.state <> $2
      ORDER BY s.last_event_at DESC`,
    [ctx.accountId, SessionState.ENDED],
  );

  const body: SessionsResponse = { sessions: res.rows.map(toSessionInfo) };
  return NextResponse.json(body, { status: 200 });
}
