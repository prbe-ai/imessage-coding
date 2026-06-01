/**
 * GET /api/account/agent-number — the AgentPhone number assigned to this
 * account (the number the user texts / opens a chat with).
 *
 * Distinct from /api/home/number, which returns the user's OWN linked number.
 * Resolving here also assigns a number on first read (idempotent); returns
 * `phoneNumber: null` only when the pool is empty.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { ensureAgentNumberForAccount } from "@/lib/agent-number";
import type { AgentNumberResponse } from "@/lib/api/contracts";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const ctx = await requireAccount(req);
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const phoneNumber = await ensureAgentNumberForAccount(ctx.accountId);
  const body: AgentNumberResponse = { phoneNumber };
  return NextResponse.json(body, { status: 200 });
}
