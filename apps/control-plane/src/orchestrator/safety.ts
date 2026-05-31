/**
 * SAFETY — the deterministic destructive-approval gate.
 *
 * The hard invariant (fail-CLOSED): the orchestrator must NEVER auto-`allow` a
 * DESTRUCTIVE permission by LLM inference. A destructive allow is permitted
 * ONLY deterministically:
 *
 *   (a) the inbound reply is a tapback / inline-reply BOUND to a specific
 *       attention event (matched by the notifyMessageId of the outbound phone
 *       notification that fronted it), OR
 *   (b) there is EXACTLY ONE pending attention event for the account and it is
 *       unambiguously the target.
 *
 * If neither holds and the reply would allow a destructive op, the orchestrator
 * must REPLY asking which (it never guesses). Steering, questions, plan
 * approvals, denials, and answers are handled by the LLM; only the destructive
 * ALLOW path is locked behind this deterministic gate.
 *
 * "Destructive" mirrors the device hook's grant semantics: file-edit tools
 * (Edit/Write/MultiEdit/NotebookEdit) are the only ones a session `grant=edits`
 * may auto-allow; Bash and everything else are treated as destructive and never
 * auto-allowed without the keyboard. We classify conservatively: UNKNOWN tools
 * are destructive.
 */
import {
  AttentionKind,
  type AttentionEvent,
  type InboundMessage,
} from '@imsg/shared';

/**
 * File-edit tools — the ONLY tools a `grant=edits` session auto-allows, and the
 * only permission tools considered NON-destructive. Mirrors the device hook's
 * EDIT_TOOLS set exactly. Keep in lockstep with the plugin.
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
  // (a) Explicit binding via the reacted-to / replied-to provider message id.
  //     The control plane persists the OUTBOUND notification's provider id on
  //     the attention (notifyMessageId), so a tapback or inline reply that
  //     carries that id binds deterministically to THAT exact attention. We do
  //     NOT match requestId/qid here — those are device-side ids the phone
  //     never sees, so they can't be a reply target.
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

/** A destructive-allow safety verdict. */
export interface DestructiveAllowCheck {
  /** True if a destructive ALLOW is permitted for `target` under the rules. */
  permitted: boolean;
  /** Reason (for logging / clarify message), when not permitted. */
  reason?: string;
}

/**
 * Decide whether allowing `target` (a permission) is safe given how the inbound
 * reply bound to it. Non-destructive tools are always allowable; destructive
 * tools require a deterministic binding.
 */
export function checkDestructiveAllow(
  target: AttentionEvent,
  binding: 'deterministic' | 'inferred',
): DestructiveAllowCheck {
  if (!isPermissionAttention(target)) {
    // Only permission events can be "allowed"; non-permissions are answered.
    return { permitted: false, reason: 'target is not a permission' };
  }
  if (!isDestructiveTool(target.toolName)) {
    return { permitted: true };
  }
  if (binding === 'deterministic') {
    return { permitted: true };
  }
  return {
    permitted: false,
    reason:
      'destructive permission may only be allowed via a deterministic binding ' +
      '(tapback/inline-reply or a single pending request) — never by inference',
  };
}
