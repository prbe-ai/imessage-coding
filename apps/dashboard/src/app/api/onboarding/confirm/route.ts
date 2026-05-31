/**
 * POST /api/onboarding/confirm
 *
 * One-tap confirmation of the derived phone number. The control-plane
 * orchestrator creates the `conversations` row (account + derived number)
 * when it matches the texted-in onboarding token; this endpoint stamps
 * `verified_at` so inbound messages from that number are trusted from here
 * on. Idempotent — re-confirming a verified number is a no-op success.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import type { OnboardingStatusResponse } from "@/lib/api/contracts";

export const dynamic = "force-dynamic";

interface ConversationRow {
  phone_number: string;
  verified_at: string | null;
}

export async function POST(req: Request): Promise<Response> {
  const ctx = await requireAccount(req);
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Verify only an already-matched conversation for this account — never
  // create one here (the orchestrator owns derivation from the inbound text).
  const res = await query<ConversationRow>(
    `UPDATE conversations
        SET verified_at = COALESCE(verified_at, now())
      WHERE account_id = $1
      RETURNING phone_number, verified_at`,
    [ctx.accountId],
  );

  const row = res.rows[0];
  if (!row) {
    return NextResponse.json(
      { error: "No number to confirm yet — text the code first." },
      { status: 409 },
    );
  }

  const body: OnboardingStatusResponse = {
    matched: true,
    phoneNumber: row.phone_number,
    verified: Boolean(row.verified_at),
  };
  return NextResponse.json(body, { status: 200 });
}
