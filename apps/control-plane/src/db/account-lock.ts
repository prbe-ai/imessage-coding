/**
 * CROSS-MACHINE per-account turn serialization, via a Postgres LEASE ROW.
 *
 * The orchestrator's in-process `withAccountLock` (orchestrator/index.ts) keeps
 * turns for one account from overlapping WITHIN a single machine. But the app
 * runs on >1 Fly machine, and an inbound text on machine A can race an
 * agent-event turn on machine B for the SAME account — two in-process chains
 * that can't see each other, double-acting on the same pending attentions. This
 * layers a DB lease UNDER that in-process chain so the two machines mutually
 * exclude. The in-process chain stays the same-machine fast path (and means only
 * one turn per machine ever contends for the lease at a time).
 *
 * A LEASE, not a held lock: ownership is a row (account_locks) stamped with
 * expires_at. We acquire it, run the turn, and explicitly DELETE it at the end —
 * the TTL is purely a CRASH BACKSTOP (a machine that dies mid-turn never deletes
 * its row, so another machine takes over once expires_at lapses). No renewal:
 * turns are short (one LLM call, already abort/timeout-bounded), so they finish
 * far inside the TTL; skipping renewal deletes a whole class of timer-lifecycle
 * + missed-renew bugs (the missed renew would itself cause the double-act we're
 * preventing). Connection-efficient: acquire/release are short pooled queries, so
 * nothing is pinned across the turn (unlike a session advisory lock) — it scales
 * to any number of accounts.
 *
 *   acquire (own it, or wait for the holder)              release (turn end)
 *   ┌──────────────────────────────────────┐             ┌────────────────────┐
 *   │ INSERT … ON CONFLICT DO UPDATE        │             │ DELETE WHERE        │
 *   │   SET owner, expires_at = now()+TTL   │   ……run……   │   account_id=$1 AND │
 *   │   WHERE expires_at < now()  (steal if │   the turn   │   owner=$token      │
 *   │   the prior holder's lease lapsed)    │             │ (only my own row)   │
 *   │ RETURNING owner   → row = we own it   │             └────────────────────┘
 *   └──────────────────────────────────────┘
 */
import { randomUUID } from 'node:crypto';
import { query } from './pool.ts';

/** Crash backstop: how long a lease lives without being released. A dead
 *  machine's lease lapses after this, letting another take over. Comfortably
 *  longer than a real turn (seconds), so the normal path never hits it. */
const LEASE_TTL_SECONDS = 120;
/** Max time a loser waits for the holder to release before proceeding
 *  best-effort. > TTL so a crashed holder's lease is guaranteed to lapse within
 *  the window (then we steal it) rather than timing out into an unlocked turn. */
const ACQUIRE_TIMEOUT_MS = 130_000;
/** Poll interval while waiting for a busy lease (acquire is a quick query; we
 *  hold no connection between attempts). */
const RETRY_MS = 200;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` while holding the account's cross-machine lease. Waits (bounded) for a
 * current holder to release, then runs. On acquire FAILURE (DB error or the
 * bounded wait elapsing) it runs `fn` anyway, best-effort — dropping a user's
 * turn is worse than the rare double-act a missed lease allows during a DB blip.
 * Always releases a lease it actually took, even if `fn` throws.
 */
export async function withAccountLease<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const held = await acquireLease(accountId, token);
  try {
    return await fn();
  } finally {
    if (held) await releaseLease(accountId, token);
  }
}

/**
 * Try to own the account's lease, polling until acquired or the bounded window
 * elapses. Returns true if we hold it (caller must release), false to proceed
 * WITHOUT the lease (best-effort). Exported for tests; `deps` lets a test inject
 * a fake `run` (the row-returning query) and tiny timings.
 */
export async function acquireLease(
  accountId: string,
  token: string,
  deps: AcquireDeps = defaultDeps,
): Promise<boolean> {
  const deadline = deps.now() + deps.timeoutMs;
  for (;;) {
    let rows: ReadonlyArray<unknown>;
    try {
      rows = await deps.run(
        `INSERT INTO account_locks (account_id, owner, expires_at)
              VALUES ($1, $2, now() + ($3::int * interval '1 second'))
         ON CONFLICT (account_id) DO UPDATE
              SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
            WHERE account_locks.expires_at < now()
         RETURNING owner`,
        [accountId, token, LEASE_TTL_SECONDS],
      );
    } catch (err) {
      // DB blip on acquire — proceed best-effort (decided). Don't drop the turn.
      console.error('[lock] lease acquire failed; proceeding without lease', err);
      return false;
    }
    // A returned row means our INSERT or our (steal-on-expired) UPDATE applied →
    // we own it. Zero rows means a live holder still owns it → wait and retry.
    if (rows.length > 0) return true;
    if (deps.now() >= deadline) {
      console.warn('[lock] lease still held after wait; proceeding best-effort', { accountId });
      return false;
    }
    await deps.sleep(deps.retryMs);
  }
}

/** Release a lease we hold. Scoped to our own token so we never delete a lease
 *  another machine took over after ours lapsed. Best-effort: a failed delete just
 *  leaves the row to expire via its TTL. */
export async function releaseLease(accountId: string, token: string): Promise<void> {
  try {
    await query('DELETE FROM account_locks WHERE account_id = $1 AND owner = $2', [
      accountId,
      token,
    ]);
  } catch (err) {
    console.error('[lock] lease release failed (will expire via TTL)', err);
  }
}

/** Injectable seam for acquireLease (real DB + real timers by default). */
export interface AcquireDeps {
  run: (text: string, params: unknown[]) => Promise<ReadonlyArray<unknown>>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
  retryMs: number;
}

const defaultDeps: AcquireDeps = {
  run: (text, params) => query(text, params),
  sleep,
  now: () => Date.now(),
  timeoutMs: ACQUIRE_TIMEOUT_MS,
  retryMs: RETRY_MS,
};
