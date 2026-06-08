/**
 * POST /api/home/session-title — set a session's display name.
 *
 * The user-side counterpart to the agent's `rename_session` tool. Both write the
 * single `sessions.title` column (account-scoped) in the shared Neon DB,
 * last-writer-wins. The rename isn't clobbered by the ≤10s heartbeat because the
 * device ships its auto-title edge-triggered (only on change). An empty/whitespace
 * title is a no-op (a label is never blanked). The `title` change fires the
 * session_state trigger → the control-plane SSE hub refreshes the dashboard.
 * Body: `{ sessionId, title }`. Mirrors the /api/home/afk write pattern.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import { isUuid, cleanSessionTitle } from "@imsg/shared";
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
  // Clean + clamp; empty after cleaning is a no-op (a label is never blanked).
  const cleaned = cleanSessionTitle(typeof title === "string" ? title : "");
  if (!cleaned) {
    return NextResponse.json({ error: "Empty title" }, { status: 422 });
  }

  // account_id is the tenant boundary; a foreign/unknown session matches 0 rows.
  const res = await query(
    `UPDATE sessions SET title = $1 WHERE id = $2 AND account_id = $3`,
    [cleaned, sessionId, ctx.accountId],
  );

  const body: SetSessionTitleResponse = {
    title: cleaned,
    updated: (res.rowCount ?? 0) > 0,
  };
  return NextResponse.json(body, { status: 200 });
}
