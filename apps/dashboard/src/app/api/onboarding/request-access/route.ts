/**
 * POST /api/onboarding/request-access
 *
 * The invite gate. A `pending` user submits the phone number they want to use;
 * we record it on their account and email an operator (richard@prbe.ai) so they
 * can add the number to Sendblue (free tier caps verified contacts) and flip
 * `access_status` to 'approved'. The user then sees the waitlist page.
 *
 * Idempotent-ish: re-submitting just overwrites `requested_phone` and re-emails.
 * Approved accounts don't need this — we no-op so a stray call can't downgrade.
 */

import { NextResponse } from "next/server";

import { AccessStatus } from "@imsg/shared";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import { notifyOperatorOfAccessRequest } from "@/lib/email";
import type {
  RequestAccessRequest,
  RequestAccessResponse,
} from "@/lib/api/contracts";

export const dynamic = "force-dynamic";

/** Normalize to a bare E.164 (`+` then 7–15 digits); null when implausible. */
function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // Keep a single leading '+', drop every other non-digit (spaces, dashes, ()).
  const digits = trimmed.replace(/(?!^\+)\D/g, "");
  const e164 = digits.startsWith("+") ? digits : `+${digits}`;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}

export async function POST(req: Request): Promise<Response> {
  const ctx = await requireAccount(req);
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Already approved — nothing to request. No-op so we never downgrade or
  // re-notify for an account that's already through the gate.
  if (ctx.accessStatus === AccessStatus.APPROVED) {
    const ok: RequestAccessResponse = { ok: true };
    return NextResponse.json(ok, { status: 200 });
  }

  let payload: RequestAccessRequest;
  try {
    payload = (await req.json()) as RequestAccessRequest;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const phone = normalizePhone(payload?.phone);
  if (!phone) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 422 });
  }

  // Record the request (only for a still-pending account).
  await query(
    `UPDATE accounts
        SET requested_phone = $1, requested_at = now()
      WHERE id = $2 AND access_status = $3`,
    [phone, ctx.accountId, AccessStatus.PENDING],
  );

  // Best-effort operator notification — never fail the user on an email hiccup.
  await notifyOperatorOfAccessRequest({ email: ctx.email, phone });

  const body: RequestAccessResponse = { ok: true };
  return NextResponse.json(body, { status: 200 });
}
