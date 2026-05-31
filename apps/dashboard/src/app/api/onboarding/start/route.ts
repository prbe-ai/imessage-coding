/**
 * POST /api/onboarding/start
 *
 * Mints a single-use, >=128-bit, short-TTL onboarding token bound to the
 * current Better Auth session and persists only its hash. The raw token is
 * returned once for the prefilled iMessage deep link
 * (`sms:&body=hey! this is <token>`). When the user texts it in, the control
 * plane's webhook orchestrator matches the embedded token back to this
 * account and derives the sender's phone number (writing `conversations`).
 *
 * Idempotency: a fresh start supersedes any prior un-used token for this
 * account+session — we burn earlier ones so only the latest deep link works.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import {
  mintRawToken,
  hashToken,
  expiryFromNow,
  ONBOARDING_TOKEN_TTL_MS,
} from "@/lib/tokens";
import type { OnboardingStartResponse } from "@/lib/api/contracts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const ctx = await requireAccount(req);
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Burn any earlier un-used token for this account+session so only the
  // freshest deep link is live (single-use, last-write-wins).
  await query(
    `UPDATE onboarding_tokens
        SET used_at = now()
      WHERE account_id = $1 AND sso_session_id = $2 AND used_at IS NULL`,
    [ctx.accountId, ctx.sessionId],
  );

  const raw = mintRawToken();
  const expiresAt = expiryFromNow(ONBOARDING_TOKEN_TTL_MS);
  await query(
    `INSERT INTO onboarding_tokens
       (token_hash, account_id, sso_session_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [hashToken(raw), ctx.accountId, ctx.sessionId, expiresAt],
  );

  const body: OnboardingStartResponse = { token: raw, expiresAt };
  return NextResponse.json(body, { status: 200 });
}
