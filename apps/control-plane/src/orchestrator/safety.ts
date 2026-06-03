/**
 * SAFETY HINTS — advisory signals the orchestrator LLM weighs; NOT hard gates.
 *
 * Per the user's directive ("drop binding everywhere; the LLM has final say"),
 * there is no longer a code-enforced destructive-approval gate. The model decides
 * every allow/deny. This module just provides the pure, tested signals it uses:
 *
 *   - `deterministicTarget` — which pending attention a reply UNAMBIGUOUSLY refers
 *     to (a tap-back reaction bound by notifyMessageId, or a lone pending). Used as
 *     a HINT to pick a target and surfaced to the model; never a refusal.
 *   - `isDestructiveTool` — classifies a permission's tool (file-edits are safe;
 *     Bash/network/unknown are destructive). Used to decide whether to NOTIFY the
 *     user before a permission and to phrase the hint — not to block an allow.
 *   - `actionAllowedForKind` — the action↔kind shape rules (approve→plan, allow→
 *     permission, answer/deny→any). Structural validity, not a safety lock.
 *
 * "Destructive" = anything other than the file-edit tools (Edit/Write/MultiEdit/
 * NotebookEdit). We classify conservatively: UNKNOWN tools are destructive.
 */
import {
  AttentionKind,
  RequestAction,
  type AttentionEvent,
  type InboundMessage,
} from '@imsg/shared';

/**
 * File-edit tools — the only permission tools considered NON-destructive (always
 * allowable; see checkDestructiveAllow). Everything else is gated. Keep in
 * lockstep with the plugin's permission handling.
 */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

/**
 * Is a permission for `toolName` destructive? Conservative & fail-closed:
 *  - missing/unknown tool        -> destructive (true)
 *  - file-edit tools             -> non-destructive (false)
 *  - everything else (Bash, ...) -> destructive (true)
 */
export function isDestructiveTool(toolName: string | undefined): boolean {
  if (!toolName) return true; // unknown -> treat as destructive
  return !EDIT_TOOLS.has(toolName);
}

/** Is this attention event a permission prompt (the gated kind)? */
export function isPermissionAttention(e: AttentionEvent): boolean {
  return e.kind === AttentionKind.PERMISSION;
}

/**
 * Which request kinds a `respond_to_request` action may target. The two gated
 * actions are constrained by kind; answer/deny apply to any pending request:
 *   - APPROVE → plans only.
 *   - ALLOW   → permissions only (the destructive-allow gate applies ON TOP).
 *   - ANSWER  → any (answering a permission just resolves it with text).
 *   - DENY    → any (always safe).
 * Pure + total: an unknown action returns false (fail-closed). Keeps the action↔kind
 * rules in one tested place instead of inlined in the async dispatcher.
 */
export function actionAllowedForKind(action: RequestAction, kind: AttentionKind): boolean {
  switch (action) {
    case RequestAction.APPROVE:
      return kind === AttentionKind.PLAN;
    case RequestAction.ALLOW:
      return kind === AttentionKind.PERMISSION;
    case RequestAction.ANSWER:
    case RequestAction.DENY:
      return true;
    default:
      return false;
  }
}

/**
 * Deterministically resolve which pending attention an inbound reply is bound
 * to, WITHOUT any LLM inference. Returns the target only when binding is
 * unambiguous:
 *   - reactionTo matches an event's notifyMessageId (the provider id of the
 *     OUTBOUND phone notification that fronted that attention), OR
 *   - exactly one pending event exists.
 * Otherwise returns undefined (ambiguous -> caller must clarify).
 */
export function deterministicTarget(
  inbound: InboundMessage,
  pending: ReadonlyArray<AttentionEvent>,
): AttentionEvent | undefined {
  // (a) Explicit binding via the reacted-to provider message id. The control
  //     plane persists the OUTBOUND notification's provider id on the attention
  //     (notifyMessageId), so a TAP-BACK that carries that id binds
  //     deterministically to THAT exact attention. Only tap-backs set
  //     reactionTo — AgentPhone gives no target id for typed replies — so a
  //     typed reply has boundId undefined and falls through to (b). We do NOT
  //     match requestId/qid here — those are device-side ids the phone never
  //     sees, so they can't be a reply target.
  const boundId = inbound.reactionTo;
  if (boundId) {
    const matches = pending.filter((e) => e.notifyMessageId === boundId);
    if (matches.length === 1) return matches[0];
    // An EXPLICIT binding that resolves to 0 (or >1) pending is ambiguous by
    // definition: force a CLARIFY. Do NOT fall through to the singleton rule —
    // an explicit-but-unresolvable reactionTo must never be coerced onto the
    // lone pending attention (that would silently approve the wrong thing).
    return undefined;
  }

  // (b) No explicit binding: exactly one pending attention — unambiguous by count.
  if (pending.length === 1) return pending[0];

  return undefined;
}

// NOTE: the former `checkDestructiveAllow` hard gate has been removed — the model
// now decides every allow/deny (the user dropped binding everywhere). `isDestructiveTool`
// above stays as a HINT/notify classifier, and `deterministicTarget` as a binding hint.
