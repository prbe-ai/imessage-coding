/**
 * Server-side session resolution.
 *
 * Reads the Better Auth session from the incoming request cookies, then
 * resolves (creating on first sight) the product `accounts` row that mirrors
 * the authenticated user's email. Route handlers call `requireAccount(req)` to
 * get an account-scoped context or a 401 to return.
 *
 * Server-only.
 */

import "server-only";

import { getAuth } from "@/lib/idp/auth";
import { query } from "@/lib/db";
import { ensureAgentNumberForAccount } from "@/lib/agent-number";

export interface SessionUser {
  /** Better Auth user id. */
  userId: string;
  email: string;
  name: string | null;
  /** Better Auth session id (used to bind single-use onboarding tokens). */
  sessionId: string;
}

interface AccountRow {
  id: string;
  email: string;
}

export interface AccountContext extends SessionUser {
  /** Product `accounts.id` — the tenant boundary every query scopes to. */
  accountId: string;
}

/** Read the Better Auth session for this request, or null when unauthenticated. */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.email || !session.session?.id) return null;
  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
    sessionId: session.session.id,
  };
}

/**
 * Resolve (and lazily create) the `accounts` row for an email. `accounts.email`
 * is UNIQUE, so the upsert is idempotent and concurrency-safe.
 */
export async function ensureAccount(email: string): Promise<AccountRow> {
  const res = await query<AccountRow & { agent_number_id: string | null }>(
    `INSERT INTO accounts (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email, agent_number_id`,
    [email],
  );
  // ON CONFLICT ... DO UPDATE always returns the row (existing or new).
  const row = res.rows[0]!;

  // Eager, best-effort agent-number assignment on first touch. The extra column
  // in RETURNING is free; the assign only runs when still unassigned. It NEVER
  // throws — an empty pool just leaves agent_number_id NULL and the dashboard
  // stays up. The one place that fails loud on a missing number is
  // /api/onboarding/start (where the user actually needs it).
  if (!row.agent_number_id) {
    await ensureAgentNumberForAccount(row.id).catch((err) => {
      console.warn("[ensureAccount] agent-number assign failed (non-fatal)", err);
      return null;
    });
  }

  return { id: row.id, email: row.email };
}

/**
 * Require an authenticated, account-scoped context. Returns null when the
 * request has no valid session — the caller returns 401.
 */
export async function requireAccount(
  req: Request,
): Promise<AccountContext | null> {
  const user = await getSessionUser(req);
  if (!user) return null;
  const account = await ensureAccount(user.email);
  return { ...user, accountId: account.id };
}
