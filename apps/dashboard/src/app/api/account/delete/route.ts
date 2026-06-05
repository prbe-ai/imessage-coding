/**
 * POST /api/account/delete
 *
 * Permanently deletes the authenticated user's account and ALL of its data, in
 * a single transaction against the one Neon database both the product and Better
 * Auth share:
 *
 *   1. `DELETE FROM accounts` — cascades to every account-scoped product table
 *      (devices, conversations, sessions, tokens, message_log, attention_events,
 *      turns, session_activity, session_data, session_inbox, pairing/onboarding
 *      tokens — all FK ON DELETE CASCADE).
 *   2. `DELETE FROM account_locks` — the only account-scoped row with no FK to
 *      `accounts` (an ephemeral per-turn lease), so it's removed explicitly.
 *   3. `DELETE FROM "user"` — the Better Auth identity; cascades to its `session`
 *      and `account` (OAuth link) rows, so every session is destroyed server-side
 *      and the user can't reach anything even if the cookie lingers.
 *   4. `DELETE FROM verification` — best-effort cleanup of any lingering
 *      verification tokens keyed by the email.
 *
 * The agent_numbers pool row stays (shared deployment data, referenced FROM the
 * account, not owned by it). The response also clears the session cookie so the
 * browser is logged out immediately; the client redirects to /sign-in.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { getDb } from "@/lib/db";
import { BETTER_AUTH_SESSION_COOKIE } from "@/lib/idp/session-cookie";
import type { DeleteAccountResponse } from "@/lib/api/contracts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const ctx = await requireAccount(req);
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    // (1) Product data — cascades across every account-scoped table.
    await client.query(`DELETE FROM accounts WHERE id = $1`, [ctx.accountId]);
    // (2) Ephemeral per-turn lease (no FK to accounts) — drop explicitly.
    await client.query(`DELETE FROM account_locks WHERE account_id = $1`, [
      ctx.accountId,
    ]);
    // (3) Better Auth identity — cascades to session + account (OAuth) rows.
    await client.query(`DELETE FROM "user" WHERE id = $1`, [ctx.userId]);
    // (4) Best-effort: lingering verification tokens keyed by email.
    await client.query(`DELETE FROM verification WHERE identifier = $1`, [
      ctx.email,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[account/delete] failed", err);
    return NextResponse.json(
      { error: "Couldn't delete your account. Please try again." },
      { status: 500 },
    );
  } finally {
    client.release();
  }

  const body: DeleteAccountResponse = { deleted: true };
  const res = NextResponse.json(body, { status: 200 });
  // Logged-out immediately — the session row is already gone above (the DELETE
  // cascades to `session`), so any lingering cookie is already dead server-side.
  // Clear it anyway; in production Better Auth prefixes the cookie with
  // `__Secure-`, so clear both names.
  res.cookies.delete(BETTER_AUTH_SESSION_COOKIE);
  res.cookies.delete(`__Secure-${BETTER_AUTH_SESSION_COOKIE}`);
  return res;
}
