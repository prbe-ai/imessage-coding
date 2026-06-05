/**
 * GET /api/home/number — the account's linked, verified phone number.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import type { LinkedNumberResponse } from "@/lib/api/contracts";

export const dynamic = "force-dynamic";

interface ConversationRow {
  phone_number: string;
  verified_at: string | null;
}

export async function GET(req: Request): Promise<Response> {
  const ctx = await requireAccount(req);
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const res = await query<ConversationRow>(
    `SELECT phone_number, verified_at
       FROM conversations
      WHERE account_id = $1
      ORDER BY verified_at DESC NULLS LAST
      LIMIT 1`,
    [ctx.accountId],
  );
  const row = res.rows[0];
  const body: LinkedNumberResponse = {
    phoneNumber: row?.phone_number ?? null,
    verified: Boolean(row?.verified_at),
  };
  return NextResponse.json(body, { status: 200 });
}
