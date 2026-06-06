/**
 * POST /api/home/session-title — set a session's manual display name.
 *
 * The user-side counterpart to the agent's `rename_session` tool. Both write
 * `sessions.manual_title` (account-scoped) in the shared Neon DB; readers surface
 * COALESCE(manual_title, title), so the rename wins over the device-derived
 * auto-title without the ≤10s heartbeat clobbering it. An empty/whitespace title
 * clears the override (revert to the auto-title). The `manual_title` change fires
 * the session_state trigger → the control-plane SSE hub refreshes the dashboard.
 * Body: `{ sessionId, title }`. Mirrors the /api/home/afk write pattern.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import { isUuid, manualTitleValue } from "@imsg/shared";
import type {
  SetSessionTitleRequest,
  SetSessionTitleResponse,
} from "@/lib/api/contracts";

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
  const { sessionId, title } = (parsed ?? {}) as Partial<SetSessionTitleRequest>;
  if (typeof sessionId !== "string" || !isUuid(sessionId)) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 422 });
  }
  // Clean + clamp; an empty result clears the override (NULL → fall back to auto).
  const manualTitle = manualTitleValue(typeof title === "string" ? title : "");

  // account_id is the tenant boundary; a foreign/unknown session matches 0 rows.
  const res = await query(
    `UPDATE sessions SET manual_title = $1 WHERE id = $2 AND account_id = $3`,
    [manualTitle, sessionId, ctx.accountId],
  );

  const body: SetSessionTitleResponse = {
    title: manualTitle,
    updated: (res.rowCount ?? 0) > 0,
  };
  return NextResponse.json(body, { status: 200 });
}
