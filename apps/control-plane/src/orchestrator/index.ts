/**
 * ASSISTANT TURN — the middleman between the user and their Claude Code agents.
 *
 * A turn is triggered by an EVENT and runs a coding-agent-style loop (tool calls
 * + outbound messages) until the model ends it:
 *   - `orchestrate(inbound)`     — the user texted (agentphone webhook).
 *   - `runAgentEventTurn(event)` — an agent needs attention (device attention POST,
 *                                  AFK-gated by the caller). NOTIFY-only.
 *
 * SAFETY (unchanged contract, enforced in code — never on the model's say-so):
 *   - A destructive permission is allowed ONLY via a deterministic binding
 *     (tap-back/inline-reply or a single pending) — `allow_permission` checks
 *     `deterministicTarget()` + `checkDestructiveAllow()` and refuses otherwise.
 *   - The model can never mint a FULL grant (`capGrant` caps to EDITS).
 *   - Agent-event turns expose only `send_message` (notify; the human resolves).
 * Fail-closed everywhere: a turn error sends a safe clarify (user path) or falls
 * back to the static notification (agent-event path) — never an unsafe action.
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
  insertSessionMessage,
  listLiveSessionsForAccount,
  listPendingAttentionForAccount,
  logMessage,
  recentMessages,
  resolveAttention,
  setAttentionNotifyMessageId,
} from '../db/repo.ts';
import { hashToken } from '../auth/device.ts';
import { runAssistantTurn, type ToolExecutor } from './llm.ts';
import { assistantTools, buildTurnMessages, type TurnMode } from './prompt.ts';
import {
  checkDestructiveAllow,
  deterministicTarget,
  isDestructiveTool,
  isPermissionAttention,
} from './safety.ts';

const HISTORY_LIMIT = 20;

/** Outcome of one turn (for logging/tests). */
export interface TurnResult {
  handled: boolean;
  accountId?: string;
  reason?: string;
  rounds?: number;
  toolCalls?: number;
  actions?: string[];
}

// --- public entrypoints -------------------------------------------------------

/**
 * USER-MESSAGE turn: resolve the sender to an account (or complete onboarding),
 * then run the assistant turn with the full action toolset.
 */
export async function orchestrate(
  inbound: InboundMessage,
  transport: Transport,
): Promise<TurnResult> {
  const conv = await findAccountByPhone(inbound.from);
  if (!conv) {
    // ONBOARDING: an unverified number texts "hey! this is <token>".
    const token = extractOnboardingToken(inbound.text);
    if (token) {
      const linked = await consumeOnboardingTokenAndLinkNumber({
        onboardingTokenHash: hashToken(token),
        phoneNumber: inbound.from,
      });
      if (linked) {
        await logMessage({ accountId: linked.accountId, direction: 'inbound', body: inbound.text });
        await sendToUser(
          transport,
          linked.accountId,
          "You're all set — your number is linked. Let's get coding.",
          { replyToMessageId: inbound.messageId, fallbackTo: inbound.from },
        );
        return { handled: true, accountId: linked.accountId, reason: 'onboarding_linked' };
      }
    }
    // Unknown/unverified, no valid token: no-op (don't leak recognition).
    return { handled: false, reason: 'unknown_or_unverified_sender' };
  }
  const accountId = conv.accountId;
  // Serialize turns per account (see withAccountLock).
  return withAccountLock(accountId, () => runUserTurn(inbound, transport, accountId));
}

/** The serialized body of a user-message turn. */
async function runUserTurn(
  inbound: InboundMessage,
  transport: Transport,
  accountId: string,
): Promise<TurnResult> {
  await logMessage({ accountId, direction: 'inbound', body: inbound.text });

  const [pending, sessions, history] = await Promise.all([
    listPendingAttentionForAccount(accountId),
    listLiveSessionsForAccount(accountId),
    recentMessages({ accountId, limit: HISTORY_LIMIT }),
  ]);
  // Deterministic binding drives the destructive-allow gate (never the model).
  const boundTarget = deterministicTarget(inbound, pending);

  const actions: string[] = [];
  const sent = { count: 0 };
  const ctx: DispatchCtx = {
    mode: 'user_message',
    accountId,
    transport,
    inbound,
    pending,
    boundTarget,
    actions,
    sent,
  };
  const messages = buildTurnMessages({
    trigger: { kind: 'user_message', inbound },
    pending,
    sessions,
    history,
  });

  try {
    const outcome = await runAssistantTurn({
      messages,
      tools: assistantTools('user_message'),
      user: accountId,
      execTool: makeExecTool(ctx),
      onUnsentText: async (text) => {
        await sendToUser(transport, accountId, text, {
          replyToMessageId: inbound.messageId,
          fallbackTo: inbound.from,
        });
        sent.count += 1;
      },
    });
    await recordActions(accountId, actions);
    return { handled: true, accountId, rounds: outcome.rounds, toolCalls: outcome.toolCalls, actions };
  } catch (err) {
    // Fail-closed: never leave the user hanging; never take an action.
    console.error('[assistant] user turn error', err);
    await sendToUser(
      transport,
      accountId,
      "Sorry — I'm having trouble reaching my brain right now. Try again in a moment.",
      { replyToMessageId: inbound.messageId, fallbackTo: inbound.from },
    );
    return { handled: true, accountId, reason: 'turn_error' };
  }
}

/**
 * AGENT-EVENT turn: an agent needs attention (caller has already AFK-gated).
 * NOTIFY-only — the assistant decides how to surface it; resolution waits for
 * the user. On no message / error, fall back to the static notification so the
 * user is never left uninformed.
 */
export function runAgentEventTurn(
  attention: AttentionEvent,
  accountId: string,
  transport: Transport,
): Promise<TurnResult> {
  // Serialized per account, same as user turns (see withAccountLock).
  return withAccountLock(accountId, () => runAgentEventTurnLocked(attention, accountId, transport));
}

async function runAgentEventTurnLocked(
  attention: AttentionEvent,
  accountId: string,
  transport: Transport,
): Promise<TurnResult> {
  // SAFETY: a DESTRUCTIVE permission gets a CODE-generated, accurate notification
  // — never LLM-authored prose. The deterministic-allow gate trusts that the user
  // saw a truthful description of what a tap-back/reply approves; an LLM notifier
  // could misdescribe a destructive op while the tap-back binds to it. So bypass
  // the assistant turn for destructive permissions and send the canonical notice.
  if (isPermissionAttention(attention) && isDestructiveTool(attention.toolName)) {
    await notifyStatic(transport, accountId, attention);
    return { handled: true, accountId, reason: 'destructive_static_notify' };
  }
  const sent = { count: 0 };
  try {
    const [pending, sessions, history] = await Promise.all([
      listPendingAttentionForAccount(accountId),
      listLiveSessionsForAccount(accountId),
      recentMessages({ accountId, limit: HISTORY_LIMIT }),
    ]);
    const actions: string[] = [];
    const ctx: DispatchCtx = {
      mode: 'agent_event',
      accountId,
      transport,
      pending,
      // Default the tap-back binding to the triggering attention.
      triggerAttentionId: attention.id,
      actions,
      sent,
    };
    const messages = buildTurnMessages({
      trigger: { kind: 'agent_event', attention },
      pending,
      sessions,
      history,
    });
    const outcome = await runAssistantTurn({
      messages,
      tools: assistantTools('agent_event'),
      user: accountId,
      execTool: makeExecTool(ctx),
      onUnsentText: async (text) => {
        const id = await sendToUser(transport, accountId, text);
        if (id) {
          sent.count += 1;
          await setAttentionNotifyMessageId(attention.id, id, accountId).catch(() => {});
        }
      },
    });
    if (sent.count === 0) {
      // Assistant chose to stay silent — still surface the event reliably.
      await notifyStatic(transport, accountId, attention);
    }
    return { handled: true, accountId, rounds: outcome.rounds, toolCalls: outcome.toolCalls };
  } catch (err) {
    console.error('[assistant] agent-event turn error; static fallback', err);
    await notifyStatic(transport, accountId, attention);
    return { handled: true, accountId, reason: 'turn_error_static_fallback' };
  }
}

// --- tool dispatch ------------------------------------------------------------

interface DispatchCtx {
  mode: TurnMode;
  accountId: string;
  transport: Transport;
  /** Present on user-message turns (for reply addressing). */
  inbound?: InboundMessage;
  pending: ReadonlyArray<AttentionEvent>;
  /** Deterministic binding for the destructive-allow gate (user-message turns). */
  boundTarget?: AttentionEvent;
  /** Default tap-back binding target for send_message (agent-event turns). */
  triggerAttentionId?: string;
  /** Recorded action notes (folded into history for multi-turn coherence). */
  actions: string[];
  /** Count of outbound messages sent this turn. */
  sent: { count: number };
}

/** Build the tool executor for one turn. Tools not throw — they return `error:`. */
function makeExecTool(ctx: DispatchCtx): ToolExecutor {
  return async (name, args) => {
    if (name === 'send_message') {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return 'error: text is required';
      const id = await sendToUser(ctx.transport, ctx.accountId, text, {
        replyToMessageId: ctx.inbound?.messageId,
        fallbackTo: ctx.inbound?.from,
      });
      // Count only ACTUAL deliveries: a failed send (no verified phone / transport
      // error) must not suppress the agent-event static fallback (sent.count === 0).
      if (id) ctx.sent.count += 1;
      const about =
        typeof args.aboutAttentionId === 'string' && args.aboutAttentionId
          ? args.aboutAttentionId
          : ctx.triggerAttentionId;
      // about is LLM-provided. The write is account-scoped (repo) so it can't
      // touch another tenant. AND we refuse to bind a tap-back to a DESTRUCTIVE
      // permission: that deterministic binding must only ever front a
      // code-generated, accurate notification (see runAgentEventTurnLocked),
      // never LLM-authored prose — otherwise the model could make the user
      // approve a destructive op it misdescribed. Non-destructive binds are safe.
      if (about && id) {
        const a = ctx.pending.find((e) => e.id === about);
        if (!a || !isPermissionAttention(a) || !isDestructiveTool(a.toolName)) {
          await setAttentionNotifyMessageId(about, id, ctx.accountId).catch(() => {});
        }
      }
      return id ? 'sent' : 'error: could not deliver (no verified phone on file)';
    }

    // Resolution + steering tools are user-message only — the human drives these.
    if (ctx.mode === 'agent_event') {
      return 'error: only send_message is available here; notify the user and let them decide';
    }

    if (name === 'steer_session') {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!sessionId || !text) return 'error: sessionId and text are required';
      // Tenant-scoped insert: only succeeds for a live session in this account.
      const res = await insertSessionMessage({ sessionId, accountId: ctx.accountId, body: text });
      if (!res) return 'error: no such live session for this account';
      ctx.actions.push(`steered session ${shortId(sessionId)}`);
      return 'sent to the session';
    }

    const attentionId = typeof args.attentionId === 'string' ? args.attentionId : '';
    if (!attentionId) return 'error: attentionId is required';
    const target = await resolveTarget(attentionId, ctx.accountId, ctx.pending);
    if (!target) return 'error: no such pending attention';

    switch (name) {
      case 'answer_attention': {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        const dec = await resolveAttention({
          accountId: ctx.accountId,
          attentionId: target.id,
          answerText: text,
          source: DecisionSource.PHONE,
        });
        if (!dec) return 'error: that attention is already resolved';
        ctx.actions.push(`answered ${target.kind} ${shortId(target.id)}`);
        return 'answered';
      }

      case 'approve_plan': {
        if (target.kind !== AttentionKind.PLAN) {
          return 'error: that attention is not a plan (approve_plan is for plans only)';
        }
        const grant = capGrant(args.grant);
        const dec = await resolveAttention({
          accountId: ctx.accountId,
          attentionId: target.id,
          behavior: DecisionBehavior.ALLOW,
          grant,
          source: DecisionSource.PHONE,
        });
        if (!dec) return 'error: that plan is already resolved';
        ctx.actions.push(`approved plan ${shortId(target.id)}${grant ? ` grant=${grant}` : ''}`);
        return grant ? `approved (standing grant: ${grant})` : 'approved';
      }

      case 'deny_attention': {
        const dec = await resolveAttention({
          accountId: ctx.accountId,
          attentionId: target.id,
          behavior: DecisionBehavior.DENY,
          source: DecisionSource.PHONE,
        });
        if (!dec) return 'error: that attention is already resolved';
        ctx.actions.push(`denied ${target.kind} ${shortId(target.id)}`);
        return 'denied';
      }

      case 'allow_permission': {
        if (!isPermissionAttention(target)) {
          return 'error: that is not a permission (use answer_attention or approve_plan)';
        }
        // A destructive allow additionally requires PROOF the user was shown a
        // code-generated, accurate notification for THIS attention:
        // notify_message_id is set only by notifyStatic for destructive perms,
        // never by the LLM (see send_message). Without it (notification lost on a
        // restart, or never sent because the user wasn't AFK at creation), a bare
        // "yes" to a lone pending must NOT approve an op the user never saw
        // described — fail closed.
        if (isDestructiveTool(target.toolName) && !target.notifyMessageId) {
          return 'refused: that request was never confirmed to you with a description, so it cannot be approved by text — act on the on-screen prompt directly.';
        }
        // THE GATE: destructive allows require a deterministic binding. The model
        // names a target; we only treat it as deterministic if it IS the bound one.
        const binding =
          ctx.boundTarget && ctx.boundTarget.id === target.id ? 'deterministic' : 'inferred';
        const check = checkDestructiveAllow(target, binding);
        if (!check.permitted) {
          return `refused: ${check.reason}. Ask the user to reply directly to that exact request to approve it.`;
        }
        const dec = await resolveAttention({
          accountId: ctx.accountId,
          attentionId: target.id,
          behavior: DecisionBehavior.ALLOW,
          source: DecisionSource.PHONE,
        });
        if (!dec) return 'error: that permission is already resolved';
        ctx.actions.push(`allowed ${target.toolName ?? 'permission'} ${shortId(target.id)}`);
        return 'allowed';
      }

      default:
        return `error: unknown tool ${name}`;
    }
  };
}

// --- helpers ------------------------------------------------------------------

/**
 * Cap an LLM-originated grant: FULL is downgraded to EDITS, OFF/invalid dropped.
 * The model can NEVER mint a FULL (auto-allow-everything) grant — that is
 * reachable only via the authenticated device/dashboard path. (Safety Contract #1.)
 */
export function capGrant(value: unknown): GrantLevel | undefined {
  if (!isGrantLevel(value)) return undefined;
  if (value === GrantLevel.OFF) return undefined;
  return value === GrantLevel.FULL ? GrantLevel.EDITS : value;
}

/**
 * Extract an onboarding token from an inbound message. The dashboard deep link
 * prefills "hey! this is <token>" where <token> is a base64url string (24 bytes
 * -> 32 chars). Match the phrase first, then a bare token. Undefined if none.
 */
export function extractOnboardingToken(text: string): string | undefined {
  const phrase = /this is\s+([A-Za-z0-9_-]{24,})/i.exec(text);
  if (phrase?.[1]) return phrase[1];
  const bare = text.trim();
  if (/^[A-Za-z0-9_-]{28,}$/.test(bare)) return bare;
  return undefined;
}

/** Resolve a model-named attention id to an account-scoped attention. */
async function resolveTarget(
  attentionId: string,
  accountId: string,
  pending: ReadonlyArray<AttentionEvent>,
): Promise<AttentionEvent | undefined> {
  const inPending = pending.find((e) => e.id === attentionId);
  if (inPending) return inPending;
  return getAttentionForAccount({ attentionId, accountId });
}

/**
 * Send an iMessage to the account's verified number and durably log it. Returns
 * the provider message id (for tap-back binding) or undefined on failure.
 * Best-effort: a transport failure is logged, never thrown.
 */
async function sendToUser(
  transport: Transport,
  accountId: string,
  text: string,
  opts?: { replyToMessageId?: string; fallbackTo?: string },
): Promise<string | undefined> {
  await logMessage({ accountId, direction: 'outbound', body: text });
  const to = (await findVerifiedPhoneForAccount(accountId)) ?? opts?.fallbackTo;
  if (!to) {
    console.error('[assistant] no verified phone for account', accountId);
    return undefined;
  }
  const msg: { to: string; text: string; replyToMessageId?: string } = { to, text };
  if (opts?.replyToMessageId) msg.replyToMessageId = opts.replyToMessageId;
  try {
    const res = await transport.send(msg);
    return res?.id;
  } catch (err) {
    console.error('[assistant] transport send failed', err);
    return undefined;
  }
}

/** Fold the turn's actions into history so the next turn knows what was done. */
async function recordActions(accountId: string, actions: string[]): Promise<void> {
  if (actions.length === 0) return;
  await logMessage({ accountId, direction: 'outbound', body: `[did: ${actions.join('; ')}]` }).catch(
    () => {},
  );
}

/** Static fallback notification (LLM down / silent turn) — keeps the user informed. */
async function notifyStatic(
  transport: Transport,
  accountId: string,
  event: AttentionEvent,
): Promise<void> {
  const id = await sendToUser(transport, accountId, composeNotification(event));
  if (id) await setAttentionNotifyMessageId(event.id, id, accountId).catch(() => {});
}

function composeNotification(event: AttentionEvent): string {
  const head =
    event.kind === AttentionKind.PERMISSION
      ? `Permission needed${event.toolName ? ` (${event.toolName})` : ''}`
      : event.kind === AttentionKind.PLAN
        ? 'Plan ready for review'
        : 'Question';
  const detail = event.description || event.inputPreview || '';
  return detail ? `${head}: ${detail}` : head;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// --- per-account serialization (in-process) -----------------------------------

/** Tail promise of the in-flight turn chain per account. */
const accountLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after any in-flight turn for `accountId` settles, chaining so turns
 * for the same account never overlap (two fast inbound texts, or a text racing
 * an agent-event turn, would otherwise interleave the loop and double-act on the
 * same pending attentions). In-process only — correct for a single instance; a
 * multi-instance deployment would need a Postgres advisory lock (see the
 * deferred burst-handling note in the plan).
 */
function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountLocks.get(accountId) ?? Promise.resolve();
  // Run regardless of how the prior turn settled (don't propagate its rejection).
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  accountLocks.set(accountId, tail);
  // GC the entry once this is the last chained turn.
  void tail.then(() => {
    if (accountLocks.get(accountId) === tail) accountLocks.delete(accountId);
  });
  return run;
}
