/**
 * GET /api/onboarding/status
 *
 * Polled by the onboarding wizard after the user taps the prefilled iMessage
 * deep link. Reports whether the control-plane webhook orchestrator has
 * matched the texted-in onboarding token to this account and derived the
 * sender's phone number (a `conversations` row), and whether that number is
 * verified yet (`conversations.verified_at`). Also reports whether the account
 * has paired a device — the wizard's pair step is gated on this, not just
 * `verified`, so a confirmed-but-unpaired user still lands on it.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import { accountHasDevice } from "@/lib/devices";
import type { OnboardingStatusResponse } from "@/lib/api/contracts";

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

  // The orchestrator inserts/updates exactly one conversation per account
  // when it matches an onboarding token. Prefer the most-recently-bound row.
  const [res, hasDevice] = await Promise.all([
    query<ConversationRow>(
      `SELECT phone_number, verified_at
         FROM conversations
        WHERE account_id = $1
        ORDER BY verified_at DESC NULLS LAST
        LIMIT 1`,
      [ctx.accountId],
    ),
    accountHasDevice(ctx.accountId),
  ]);

  const row = res.rows[0];
  const body: OnboardingStatusResponse = {
    matched: Boolean(row),
    phoneNumber: row?.phone_number ?? null,
    verified: Boolean(row?.verified_at),
    hasDevice,
  };
  return NextResponse.json(body, { status: 200 });
}
