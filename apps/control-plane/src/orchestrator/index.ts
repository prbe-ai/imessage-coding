/**
 * ORCHESTRATOR — resolve an inbound text reply into a Decision.
 *
 * Flow:
 *   1. Resolve the inbound `from` number to a verified conversation -> account.
 *   2. Load that account's live sessions, pending attention events, and recent
 *      thread history.
 *   3. DETERMINISTIC binding first: find the attention the reply is bound to
 *      (tapback/inline-reply by the outbound notification's notifyMessageId, or
 *      the single pending event).
 *   4. Ask the LLM what the reply MEANS (answer / approve / deny / allow /
 *      steer / clarify). The LLM never gets to allow a destructive op — that is
 *      enforced in code against the deterministic binding.
 *   5. Persist a Decision (which fires LISTEN/NOTIFY to wake the device) and/or
 *      send outbound text via the transport.
 *
 * SAFETY: a destructive allow is honored ONLY when the binding is deterministic.
 * Anything ambiguous -> we REPLY asking which (never guess). Fail-closed on
 * every error path (LLM error, parse failure, no account) -> we do NOT allow.
 */
import {
  AttentionKind,
  DecisionBehavior,
  DecisionSource,
  GrantLevel,
  isGrantLevel,
  type AttentionEvent,
  type InboundMessage,
} from '@imsg/shared';
import type { Transport } from '@imsg/transport';
import {
  consumeOnboardingTokenAndLinkNumber,
  findAccountByPhone,
  findVerifiedPhoneForAccount,
  getAttentionForAccount,
  listLiveSessionsForAccount,
  listPendingAttentionForAccount,
  logMessage,
  recentMessages,
  resolveAttention,
} from '../db/repo.ts';
import { hashToken } from '../auth/device.ts';
import { llmComplete, parseJsonObject } from './llm.ts';
import { buildMessages, LlmActionType, type LlmAction } from './prompt.ts';
import {
  checkDestructiveAllow,
  deterministicTarget,
  isPermissionAttention,
} from './safety.ts';

const HISTORY_LIMIT = 20;

/** Outcome of orchestrating one inbound message (for logging/tests). */
export interface OrchestratorResult {
  handled: boolean;
  accountId?: string;
  action?: LlmActionType;
  resolvedAttentionId?: string;
  reply?: string;
  reason?: string;
}

/**
 * Orchestrate one inbound message end-to-end. Never throws for an expected
 * outcome (unknown sender, ambiguity, LLM failure) — those resolve to a safe,
 * logged result, sending a clarifying reply when appropriate.
 */
export async function orchestrate(
  inbound: InboundMessage,
  transport: Transport,
): Promise<OrchestratorResult> {
  // 1) Resolve sender -> account. Unknown/unverified numbers are ignored (we do
  //    NOT leak that the number is unrecognized; just no-op).
  const conv = await findAccountByPhone(inbound.from);
  if (!conv) {
    // Possible ONBOARDING: an as-yet-unverified number texts "hey! this is
    // <token>". Consume the single-use token to link + verify this number to
    // its account, completing onboarding (the dashboard then sees it verified).
    const token = extractOnboardingToken(inbound.text);
    if (token) {
      const linked = await consumeOnboardingTokenAndLinkNumber({
        onboardingTokenHash: hashToken(token),
        phoneNumber: inbound.from,
      });
      if (linked) {
        await logMessage({ accountId: linked.accountId, direction: 'inbound', body: inbound.text });
        await sendOutbound(
          transport,
          linked.accountId,
          inbound,
          "You're all set — your number is linked. Let's get coding.",
        );
        return { handled: true, accountId: linked.accountId, reason: 'onboarding_linked' };
      }
    }
    // Unknown/unverified and no valid token: no-op (don't leak recognition).
    return { handled: false, reason: 'unknown_or_unverified_sender' };
  }
  const accountId = conv.accountId;

  // Durable log of the inbound text (account-scoped thread history).
  await logMessage({ accountId, direction: 'inbound', body: inbound.text });

  // 2) Load context.
  const [pending, sessions, history] = await Promise.all([
    listPendingAttentionForAccount(accountId),
    listLiveSessionsForAccount(accountId),
    recentMessages({ accountId, limit: HISTORY_LIMIT }),
  ]);

  // 3) Deterministic binding (no LLM): which attention is this reply bound to?
  const boundTarget = deterministicTarget(inbound, pending);

  // 4) Ask the LLM what the reply means. On ANY failure -> fail-closed clarify.
  let action: LlmAction | undefined;
  try {
    const completion = await llmComplete(
      buildMessages({ inbound, pending, sessions, history }),
    );
    action = validateAction(parseJsonObject(completion));
  } catch (err) {
    console.error('[orchestrator] llm error', err);
    action = undefined;
  }

  if (!action) {
    return reply(
      transport,
      accountId,
      inbound,
      pending.length > 1
        ? "I couldn't tell which request that's for — can you say which one?"
        : "Sorry, I didn't catch that — can you rephrase?",
      { action: LlmActionType.CLARIFY, reason: 'llm_unavailable_or_unparseable' },
    );
  }

  // Resolve the LLM-named target (account-scoped) and reconcile with the
  // deterministic binding. The deterministic binding WINS for any allow path.
  const llmTarget = await resolveLlmTarget(action, accountId, pending, boundTarget);

  switch (action.type) {
    case LlmActionType.STEER: {
      // Free-text steering: push into the session. With no per-session inbound
      // relay channel here, we acknowledge and rely on the device pulling the
      // message; persist nothing as a Decision (no attention to resolve).
      const text = action.text?.trim();
      if (text) {
        await sendOutbound(transport, accountId, inbound, text);
      }
      return { handled: true, accountId, action: action.type };
    }

    case LlmActionType.CLARIFY: {
      return reply(
        transport,
        accountId,
        inbound,
        action.text?.trim() ||
          'Which request did you mean? Reply to the specific message.',
        { action: action.type },
      );
    }

    case LlmActionType.ANSWER: {
      if (!llmTarget) {
        return reply(transport, accountId, inbound, clarifyWhich(pending), {
          action: LlmActionType.CLARIFY,
          reason: 'no_target_for_answer',
        });
      }
      const answer = action.text?.trim() || inbound.text;
      const decision = await resolveAttention({
        accountId,
        attentionId: llmTarget.id,
        answerText: answer,
        source: DecisionSource.PHONE,
      });
      return {
        handled: decision !== undefined,
        accountId,
        action: action.type,
        resolvedAttentionId: llmTarget.id,
      };
    }

    case LlmActionType.APPROVE_PLAN: {
      if (!llmTarget || llmTarget.kind !== AttentionKind.PLAN) {
        return reply(transport, accountId, inbound, clarifyWhich(pending), {
          action: LlmActionType.CLARIFY,
          reason: 'no_plan_target',
        });
      }
      const decision = await resolveAttention({
        accountId,
        attentionId: llmTarget.id,
        behavior: DecisionBehavior.ALLOW,
        grant: action.grant,
        source: DecisionSource.PHONE,
      });
      return {
        handled: decision !== undefined,
        accountId,
        action: action.type,
        resolvedAttentionId: llmTarget.id,
      };
    }

    case LlmActionType.DENY: {
      if (!llmTarget) {
        return reply(transport, accountId, inbound, clarifyWhich(pending), {
          action: LlmActionType.CLARIFY,
          reason: 'no_target_for_deny',
        });
      }
      // Deny is always safe (fail-closed direction).
      const decision = await resolveAttention({
        accountId,
        attentionId: llmTarget.id,
        behavior: DecisionBehavior.DENY,
        source: DecisionSource.PHONE,
      });
      return {
        handled: decision !== undefined,
        accountId,
        action: action.type,
        resolvedAttentionId: llmTarget.id,
      };
    }

    case LlmActionType.ALLOW: {
      // THE GATED PATH. An allow requires a permission target. The binding used
      // is the DETERMINISTIC one — we do NOT trust the LLM-named target for an
      // allow. The allow is honored only if non-destructive, or if a
      // deterministic binding exists for a destructive tool.
      const target = boundTarget;
      if (!target || !isPermissionAttention(target)) {
        return reply(transport, accountId, inbound, clarifyWhich(pending), {
          action: LlmActionType.CLARIFY,
          reason: 'allow_without_deterministic_permission_target',
        });
      }
      const check = checkDestructiveAllow(target, 'deterministic');
      if (!check.permitted) {
        return reply(
          transport,
          accountId,
          inbound,
          'That looks risky and I need a clear confirmation — reply directly to ' +
            'that exact request to approve it.',
          { action: LlmActionType.CLARIFY, reason: check.reason ?? 'destructive_blocked' },
        );
      }
      const decision = await resolveAttention({
        accountId,
        attentionId: target.id,
        behavior: DecisionBehavior.ALLOW,
        grant: action.grant,
        source: DecisionSource.PHONE,
      });
      return {
        handled: decision !== undefined,
        accountId,
        action: action.type,
        resolvedAttentionId: target.id,
      };
    }

    default: {
      // Exhaustiveness guard — unknown action types fail closed to clarify.
      return reply(transport, accountId, inbound, clarifyWhich(pending), {
        action: LlmActionType.CLARIFY,
        reason: 'unknown_action',
      });
    }
  }
}

// --- helpers ------------------------------------------------------------------

/**
 * Extract an onboarding token from an inbound message. The dashboard's deep link
 * prefills the body "hey! this is <token>" where <token> is a base64url string
 * (24 bytes -> 32 chars). Match the phrase first, then fall back to a bare token
 * (autocorrect/quoting tolerant). Returns undefined if no token-shaped run.
 */
export function extractOnboardingToken(text: string): string | undefined {
  const phrase = /this is\s+([A-Za-z0-9_-]{24,})/i.exec(text);
  if (phrase?.[1]) return phrase[1];
  const bare = text.trim();
  if (/^[A-Za-z0-9_-]{28,}$/.test(bare)) return bare;
  return undefined;
}

function clarifyWhich(pending: ReadonlyArray<AttentionEvent>): string {
  if (pending.length > 1) {
    return "There are a few things waiting — which one is that for?";
  }
  return "I'm not sure what to do with that — can you clarify?";
}

/** Resolve the attention the LLM named, scoped to the account. */
async function resolveLlmTarget(
  action: LlmAction,
  accountId: string,
  pending: ReadonlyArray<AttentionEvent>,
  boundTarget: AttentionEvent | undefined,
): Promise<AttentionEvent | undefined> {
  if (action.targetAttentionId) {
    // Prefer an in-memory pending hit; fall back to a scoped DB load.
    const inPending = pending.find((e) => e.id === action.targetAttentionId);
    if (inPending) return inPending;
    return getAttentionForAccount({
      attentionId: action.targetAttentionId,
      accountId,
    });
  }
  // No explicit id from the LLM: fall back to the deterministic binding.
  return boundTarget;
}

/** Send a clarifying reply, log it, and return a CLARIFY result. */
async function reply(
  transport: Transport,
  accountId: string,
  inbound: InboundMessage,
  text: string,
  meta: { action: LlmActionType; reason?: string },
): Promise<OrchestratorResult> {
  await sendOutbound(transport, accountId, inbound, text);
  const result: OrchestratorResult = {
    handled: true,
    accountId,
    action: meta.action,
    reply: text,
  };
  if (meta.reason) result.reason = meta.reason;
  return result;
}

/** Send outbound text to the sender and durably log it. Best-effort send. */
async function sendOutbound(
  transport: Transport,
  accountId: string,
  inbound: InboundMessage,
  text: string,
): Promise<void> {
  await logMessage({ accountId, direction: 'outbound', body: text });
  // Prefer replying to the verified account number; fall back to the sender.
  const to = (await findVerifiedPhoneForAccount(accountId)) ?? inbound.from;
  const msg: { to: string; text: string; replyToMessageId?: string } = { to, text };
  if (inbound.messageId) msg.replyToMessageId = inbound.messageId;
  try {
    await transport.send(msg);
  } catch (err) {
    // Never let a transport failure break the request; the message is logged.
    console.error('[orchestrator] transport send failed', err);
  }
}

/** Validate a parsed LLM object into an LlmAction (or undefined if malformed). */
export function validateAction(obj: Record<string, unknown> | undefined): LlmAction | undefined {
  if (!obj) return undefined;
  const type = obj['type'];
  if (typeof type !== 'string') return undefined;
  if (!(Object.values(LlmActionType) as string[]).includes(type)) return undefined;

  const action: LlmAction = { type: type as LlmActionType };

  const target = obj['targetAttentionId'];
  if (typeof target === 'string' && target.length > 0) {
    action.targetAttentionId = target;
  }
  const text = obj['text'];
  if (typeof text === 'string') action.text = text;

  // GRANT SOURCE LOCKDOWN (safety, Contract #1): the LLM must NEVER be able to
  // set GrantLevel.FULL. Cap any LLM-originated grant at EDITS — a model that
  // says "full" is treated as EDITS (the device intercept auto-allows ONLY
  // file-edit tools under edits; FULL/auto-allow-all is reachable ONLY via the
  // authenticated dashboard path). OFF is treated as no grant (omitted).
  const grant = obj['grant'];
  if (isGrantLevel(grant) && grant !== GrantLevel.OFF) {
    action.grant = grant === GrantLevel.FULL ? GrantLevel.EDITS : grant;
  }

  return action;
}
