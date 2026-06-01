/**
 * Agent-number assignment — which AgentPhone number an account texts.
 *
 * The dashboard tells each user which number to message (onboarding deep link)
 * and chat with (Home CTA). That number is NOT a build-time constant: it comes
 * from the `agent_numbers` pool and is bound to the account via
 * `accounts.agent_number_id`, so going multi-number later is a data change, not
 * a code change.
 *
 *   PHASE 1 (now): one active row in the pool, shared by every account.
 *   PHASE 2 (dedicated): swap the "pick" step for a FOR UPDATE SKIP LOCKED claim
 *                        (or a provisioning call). Callers here do not change.
 *
 * Server-only.
 */

import "server-only";

import { query } from "@/lib/db";

/** SELECT the account's currently-assigned number, NULL when unassigned OR when
 *  the assigned number has since been deactivated. The `an.active` filter is a
 *  fail-closed guard: we never hand out a number we no longer control (e.g. one
 *  AgentPhone retired), even if an account still points at it. Reassigning an
 *  already-assigned account to a fresh number is Phase-2 work (the guarded
 *  UPDATE below only writes when agent_number_id IS NULL). */
async function assignedNumber(accountId: string): Promise<string | null> {
  const res = await query<{ phone_number: string }>(
    `SELECT an.phone_number
       FROM accounts a
       JOIN agent_numbers an ON an.id = a.agent_number_id AND an.active
      WHERE a.id = $1`,
    [accountId],
  );
  return res.rows[0]?.phone_number ?? null;
}

/**
 * Resolve the AgentPhone number assigned to an account, assigning one from the
 * pool on first call. Idempotent. Concurrency-safe in Phase 1 by invariant: the
 * pool has one active row, so two concurrent first-touches pick the SAME row and
 * the guarded UPDATE + re-read converge on the same number. Phase 2 (multiple
 * active rows) must replace the pick with a `FOR UPDATE SKIP LOCKED` claim.
 *
 * Returns the E.164 number, or `null` when the pool is empty (no active row).
 * Best-effort callers (ensureAccount) ignore null and leave the account
 * unassigned; `/api/onboarding/start` treats null as fail-loud (500).
 */
export async function ensureAgentNumberForAccount(
  accountId: string,
): Promise<string | null> {
  // 1. Already assigned -> return it (idempotent fast path, no write).
  const existing = await assignedNumber(accountId);
  if (existing) return existing;

  // 2. Pick a number to assign. NOW: the single active pool row. `, id` is a
  //    deterministic tiebreaker so bulk-seeded rows sharing a created_at don't
  //    order non-deterministically.
  const pick = await query<{ id: string }>(
    `SELECT id FROM agent_numbers WHERE active ORDER BY created_at, id LIMIT 1`,
  );
  const pickedId = pick.rows[0]?.id;
  if (!pickedId) {
    console.warn("[agent-number] pool empty — no active agent_numbers row");
    return null;
  }

  // 3. Guarded assign: set only while still unassigned, so two concurrent
  //    first-touches can't double-write. Then re-read so we return the number
  //    that actually won (ours or the racer's — same row in the shared phase).
  await query(
    `UPDATE accounts SET agent_number_id = $2
      WHERE id = $1 AND agent_number_id IS NULL`,
    [accountId, pickedId],
  );
  return assignedNumber(accountId);
}
