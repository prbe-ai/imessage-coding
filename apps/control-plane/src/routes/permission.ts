/**
 * BLOCKING approve-and-resume — the pure parts (constants + response shaping).
 *
 * Codex (unlike Claude Code) has NO native verdict-push channel: there is no
 * Channels permission capability to relay an allow/deny into. Instead its
 * `PermissionRequest` hook POSTs the pending destructive tool to
 * POST /api/device/permission and BLOCKS on the HTTP response — when the call
 * returns {behavior:"allow"|"deny"} the hook allows/denies the parked command.
 * The verdict itself is produced by the EXACT same machinery as CC: the user
 * tap-backs the phone notification, the orchestrator resolves the attention
 * through the deterministic binding gate (safety.ts), and resolveAttention writes
 * a `session_inbox` row kind='verdict'. The endpoint only SURFACES + WAITS; it
 * never decides allow itself.
 *
 * This module holds the pieces that are pure functions of their inputs so they
 * can be unit-tested without a DB — the deadline→explicit-deny shaping, the
 * verdict→response shaping, and the constant that encodes the deadline invariant.
 * The route (routes/device.ts) wires these to the DB/listener/orchestrator.
 */
import { DecisionBehavior } from '@imsg/shared';

/**
 * Server-side deadline for the blocking permission wait. If no verdict lands
 * within this window we return an EXPLICIT deny (never a hang, never an allow).
 *
 * DEADLINE INVARIANT (critical):
 *   PERMISSION_DEADLINE_MS  <  the Codex hook's `timeout` (~60min / 3_600_000ms).
 *
 * Why it MUST be strictly shorter: when the Codex hook's own timeout lapses, its
 * `decision` falls through to `None` — which resumes the UNATTENDED LOCAL prompt
 * (NOT a clean remote deny). So the control plane must answer FIRST: by returning
 * an explicit deny before the hook gives up, a no-answer is always a clean deny
 * and never silently falls through to a local prompt no one is at the keyboard to
 * see. Set generously (the user is answering from a phone) but with comfortable
 * headroom under the hook timeout for the network round-trip.
 *
 * ~50 minutes: long enough for a phone reply, ~10 min under a 60-min hook timeout.
 * If the hook's timeout is ever lowered, this MUST be lowered to stay below it
 * (see assertDeadlineBelowHookTimeout + the test that guards the relationship).
 */
export const PERMISSION_DEADLINE_MS = 50 * 60 * 1_000; // 3_000_000

/**
 * The hook `timeout` this deadline is sized against (the Codex
 * PermissionRequest hook's recommended `timeout_sec`, in ms). Documentation +
 * the lower bound the invariant is checked against — NOT a value we send; the
 * hook owns its own timeout. Kept here so the relationship is one assertion away.
 */
export const CODEX_HOOK_TIMEOUT_MS = 60 * 60 * 1_000; // 3_600_000

/** The shape the Codex hook consumes. `reason` is advisory (surfaced in logs / a
 *  denied-command notice); `behavior` is the load-bearing field. */
export interface PermissionVerdict {
  behavior: DecisionBehavior;
  reason?: string;
}

/**
 * The response when the deadline fires before any verdict arrives: an EXPLICIT
 * deny. Pure + total — the single source of the "timeout is a clean deny, never
 * a fall-through" contract. NEVER returns allow.
 */
export function deadlineDenyResponse(): PermissionVerdict {
  return { behavior: DecisionBehavior.DENY, reason: 'approval deadline' };
}

/**
 * Shape a resolved verdict (allow/deny) into the hook response. Pure passthrough
 * of the behavior the user chose — allow→allow, deny→deny — with no widening: any
 * value that is not exactly ALLOW is treated as deny (fail-closed), so a
 * malformed verdict can never resume a destructive command.
 */
export function verdictResponse(behavior: DecisionBehavior): PermissionVerdict {
  return behavior === DecisionBehavior.ALLOW
    ? { behavior: DecisionBehavior.ALLOW }
    : { behavior: DecisionBehavior.DENY };
}

/**
 * Guard the deadline invariant at module-load / call sites: the server deadline
 * MUST be strictly less than the hook timeout it is sized against. Throws (loud,
 * not silent) if the relationship is ever violated by a future edit — a deadline
 * that is NOT shorter would let the hook time out first and fall through to the
 * unattended local prompt. Returns the (validated) deadline for convenient use.
 */
export function assertDeadlineBelowHookTimeout(
  deadlineMs: number = PERMISSION_DEADLINE_MS,
  hookTimeoutMs: number = CODEX_HOOK_TIMEOUT_MS,
): number {
  if (!(deadlineMs < hookTimeoutMs)) {
    throw new Error(
      `PERMISSION_DEADLINE_MS (${deadlineMs}ms) must be strictly less than the Codex ` +
        `hook timeout (${hookTimeoutMs}ms): a server deadline that is not shorter would ` +
        `let the hook time out first and fall through to the unattended local prompt.`,
    );
  }
  return deadlineMs;
}
