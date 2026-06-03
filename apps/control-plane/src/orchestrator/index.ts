/**
 * ASSISTANT TURN — the middleman between the user and their Claude Code agents.
 *
 * A turn is triggered by an EVENT and runs a coding-agent-style loop (tool calls
 * + outbound messages) until the model ends it:
 *   - `orchestrate(inbound)`       — the user texted (agentphone webhook).
 *   - `runAgentEventTurn(event)`   — an agent is blocked on a permission/question/
 *                                    plan (device attention POST, AFK-gated). NOTIFY-only.
 *   - `relayAgentMessage(message)` — an agent sent a fire-and-forget status/result
 *                                    (device /message POST, AFK-gated). NOTIFY-only.
 *     This is the SPLIT: a status relay never becomes an attention / `resolved`
 *     row — the server agent relays it and drops it.
 *
 * SAFETY (unchanged contract, enforced in code — never on the model's say-so):
 *   - A destructive permission is allowed ONLY via a deterministic binding
 *     (a tap-back reaction, or a single pending — a typed reply carries no link)
 *     — `respond_to_request` (action `allow`) checks `deterministicTarget()` +
 *     `checkDestructiveAllow()`, refuses else.
 *   - The model can never mint a FULL grant (`capGrant` caps to EDITS).
 *   - The agent-driven turns expose only `text_user` (notify; the human resolves).
 * Fail-closed everywhere: a turn error sends a safe clarify (user path) or falls
 * back to the static notification (agent-event path) — never an unsafe action.
 */
import {
  AfkState,
  AttentionKind,
  DecisionBehavior,
  DecisionSource,
  GrantLevel,
  RequestAction,
  isAfkState,
  isGrantLevel,
  isUuid,
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
  recentSessionActivity,
  resolveAttention,
  setAttentionNotifyMessageId,
  setSessionsAfkForAccount,
} from '../db/repo.ts';
import { hashToken } from '../auth/device.ts';
import { runAssistantTurn, type ToolExecutor } from './llm.ts';
import {
  assistantTools,
  buildTurnMessages,
  type SessionActivityMap,
  type TurnMode,
} from './prompt.ts';
import {
  actionAllowedForKind,
  checkDestructiveAllow,
  deterministicTarget,
  isDestructiveTool,
  isPermissionAttention,
} from './safety.ts';

const HISTORY_LIMIT = 20;

/** Per-session activity surfaced into the turn snapshot (bounded to keep the
 *  prompt small): the N most-recent live sessions, last M events each. */
const ACTIVITY_PER_SESSION = 8;
const MAX_ACTIVITY_SESSIONS = 5;

/** Recent AFK-tap activity for the most-recent live sessions, keyed by id. */
async function loadSessionActivity(
  accountId: string,
  sessions: ReadonlyArray<{ id: string }>,
): Promise<SessionActivityMap> {
  const top = sessions.slice(0, MAX_ACTIVITY_SESSIONS);
  const entries = await Promise.all(
    top.map(
      async (s) =>
        [s.id, await recentSessionActivity({ sessionId: s.id, accountId, limit: ACTIVITY_PER_SESSION })] as const,
    ),
  );
  const map: SessionActivityMap = {};
  for (const [id, acts] of entries) if (acts.length > 0) map[id] = acts;
  return map;
}

/** Outcome of one turn (for logging/tests). */
export interface TurnResult {
  handled: boolean;
  accountId?: string;
  reason?: string;
  rounds?: number;
  toolCalls?: number;
  actions?: string[];
  /** Set when a user turn was INTERRUPTED before committing any side effect — a
   *  newer inbound arrived, so the drain re-runs one combined turn (it delivered
   *  nothing; `handled` is false). See drainUserQueue. */
  aborted?: boolean;
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
  // Log the inbound once, on receipt and BEFORE the drain reads history — so the
  // turn's RECENT THREAD is built deterministically (not racing an async write)
  // and a re-run of an interrupted batch never double-logs. Best-effort: a
  // logging blip must not drop the message. (The real prologue that gates the
  // webhook's claim-release is findAccountByPhone above, already awaited; this
  // is detached from the 200-ack because the webhook fire-and-forgets orchestrate.)
  await logMessage({ accountId, direction: 'inbound', body: inbound.text }).catch((err) => {
    console.error('[assistant] failed to log inbound', err);
  });
  // Coalesce back-to-back texts. Enqueue; a single per-account drain loop runs
  // the turn(s). A new text that lands BEFORE the current turn replies INTERRUPTS
  // it and re-runs ONE combined turn over both (the typo-correction case); a text
  // that lands AFTER the reply runs as its own turn.
  enqueueUserMessage(accountId, inbound, transport);
  return { handled: true, accountId, reason: 'enqueued' };
}

/**
 * The serialized body of a user-message turn, run over a BATCH of inbound
 * messages coalesced back-to-back (usually one; more when the user fired several
 * before we replied). `signal` interrupts the turn while it is still uncommitted
 * so a newer inbound can re-coalesce; `commit` latches true the instant the turn
 * sends or acts (after which the signal is ignored — see runAssistantTurn).
 * Fail-closed: any error sends a safe clarify and never throws to the drain.
 */
async function runUserTurn(
  batch: ReadonlyArray<InboundMessage>,
  transport: Transport,
  accountId: string,
  signal: AbortSignal,
  commit: { committed: boolean },
): Promise<TurnResult> {
  // Address replies to the most recent message of the burst.
  const last = batch[batch.length - 1];
  if (!last) return { handled: false, accountId, reason: 'empty_batch' };

  try {
    // (Inbound messages are logged once on receipt in orchestrate, NOT here —
    //  re-running an interrupted batch must not double-log them.)
    const [pending, sessions, history] = await Promise.all([
      listPendingAttentionForAccount(accountId),
      listLiveSessionsForAccount(accountId),
      recentMessages({ accountId, limit: HISTORY_LIMIT }),
    ]);
    // Deterministic binding drives the destructive-allow gate (never the model).
    // A tap-back / inline reply in the burst (if any) binds; else the latest text.
    const bindingInbound = [...batch].reverse().find((m) => m.reactionTo) ?? last;
    const boundTarget = deterministicTarget(bindingInbound, pending);

    const actions: string[] = [];
    const sent = { count: 0 };
    const ctx: DispatchCtx = {
      mode: 'user_message',
      accountId,
      transport,
      inbound: last,
      pending,
      boundTarget,
      actions,
      sent,
    };
    const activity = await loadSessionActivity(accountId, sessions);
    const messages = buildTurnMessages({
      trigger: { kind: 'user_message', inbounds: batch },
      pending,
      sessions,
      history,
      activity,
    });

    const outcome = await runAssistantTurn({
      messages,
      tools: assistantTools('user_message'),
      user: accountId,
      signal,
      commit,
      execTool: makeExecTool(ctx),
      onUnsentText: async (text) => {
        await sendToUser(transport, accountId, text, {
          replyToMessageId: last.messageId,
          fallbackTo: last.from,
        });
        sent.count += 1;
      },
    });
    // Interrupted before committing anything: deliver nothing and let the drain
    // re-run a fresh combined turn that includes the newer inbound(s).
    if (outcome.aborted) {
      return { handled: false, accountId, reason: 'interrupted', aborted: true };
    }
    await recordActions(accountId, actions);
    return { handled: true, accountId, rounds: outcome.rounds, toolCalls: outcome.toolCalls, actions };
  } catch (err) {
    // Fail-closed: never leave the user hanging; never take an action. (Also
    // covers a prologue blip — logMessage / context load — which used to escape
    // to the webhook; now the drain is detached, so we absorb it here.)
    console.error('[assistant] user turn error', err);
    await sendToUser(
      transport,
      accountId,
      "Sorry — I'm having trouble reaching my brain right now. Try again in a moment.",
      { replyToMessageId: last.messageId, fallbackTo: last.from },
    ).catch(() => {});
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
    const activity = await loadSessionActivity(accountId, sessions);
    const messages = buildTurnMessages({
      trigger: { kind: 'agent_event', attention },
      pending,
      sessions,
      history,
      activity,
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

/**
 * AGENT-MESSAGE relay: an agent sent a fire-and-forget status/result (device
 * /api/device/message, AFK-gated by the caller). NOTIFY-only — the server agent
 * frames it and texts the user. This is the SPLIT from attentions: there is NO
 * `attention_events` row and NOTHING to resolve, so it never joins the pending
 * pile. Best-effort: a status update is not safety-critical.
 */
export function relayAgentMessage(
  message: { sessionId: string; text: string },
  accountId: string,
  transport: Transport,
): Promise<TurnResult> {
  // Serialized per account, same as every other turn (see withAccountLock) so a
  // relay can't interleave with a user turn and double-act on pending requests.
  return withAccountLock(accountId, () => relayAgentMessageLocked(message, accountId, transport));
}

async function relayAgentMessageLocked(
  message: { sessionId: string; text: string },
  accountId: string,
  transport: Transport,
): Promise<TurnResult> {
  const sent = { count: 0 };
  try {
    const [pending, sessions, history] = await Promise.all([
      listPendingAttentionForAccount(accountId),
      listLiveSessionsForAccount(accountId),
      recentMessages({ accountId, limit: HISTORY_LIMIT }),
    ]);
    const actions: string[] = [];
    const ctx: DispatchCtx = {
      mode: 'agent_message',
      accountId,
      transport,
      pending,
      actions,
      sent,
    };
    const activity = await loadSessionActivity(accountId, sessions);
    const messages = buildTurnMessages({
      trigger: { kind: 'agent_message', sessionId: message.sessionId, text: message.text },
      pending,
      sessions,
      history,
      activity,
    });
    const outcome = await runAssistantTurn({
      messages,
      tools: assistantTools('agent_message'),
      user: accountId,
      execTool: makeExecTool(ctx),
      onUnsentText: async (text) => {
        const id = await sendToUser(transport, accountId, text);
        if (id) sent.count += 1;
      },
    });
    // Guarantee the user hears back: if the model relayed nothing (silent turn),
    // fall back to forwarding the agent's own text. The whole point is that every
    // command gets a response — better to over-relay than silently drop the answer.
    if (sent.count === 0) {
      await sendToUser(transport, accountId, message.text);
    }
    return { handled: true, accountId, rounds: outcome.rounds, toolCalls: outcome.toolCalls };
  } catch (err) {
    // Best-effort: forward the raw status so a turn-engine error never eats the
    // agent's answer. Guard on sent.count === 0 (mirrors the success path) — if
    // the model already delivered a summary before the turn threw mid-round, a
    // raw forward here would DUPLICATE it. Never throws out (caller fired + moved on).
    console.error('[assistant] agent-message relay error', err);
    if (sent.count === 0) {
      await sendToUser(transport, accountId, message.text).catch(() => {});
    }
    return { handled: true, accountId, reason: 'relay_error_raw_forward' };
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
  /** Default tap-back binding target for text_user (agent-event turns). */
  triggerAttentionId?: string;
  /** Recorded action notes (folded into history for multi-turn coherence). */
  actions: string[];
  /** Count of outbound messages sent this turn. */
  sent: { count: number };
}

/** Build the tool executor for one turn. Tools never throw — they return `error:`.
 *  Capable tools: text_user (any turn), send_to_session + respond_to_request +
 *  set_afk (user-message turns only). */
function makeExecTool(ctx: DispatchCtx): ToolExecutor {
  return async (name, args) => {
    if (name === 'text_user') {
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
        typeof args.about_request_id === 'string' && args.about_request_id
          ? args.about_request_id
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

    // Steering + resolution are user-message only — the human drives these. Both
    // agent-driven turns (attention + status relay) are notify-only.
    if (ctx.mode !== 'user_message') {
      return 'error: only text_user is available here; notify the user and let them decide';
    }

    if (name === 'surface_request') {
      const requestId = typeof args.request_id === 'string' ? args.request_id : '';
      if (!requestId) return 'error: request_id is required';
      const target = await resolveTarget(requestId, ctx.accountId, ctx.pending);
      if (!target) return 'error: no such pending request';
      const id = await surfaceRequestMessage(ctx, target);
      if (!id) return 'error: could not deliver (no verified phone on file)';
      ctx.actions.push(`surfaced ${target.kind} ${shortId(target.id)} for tap-back`);
      return 'surfaced — the user can now tap-back 👍 (allow) / 👎 (deny) on the message I just posted';
    }

    if (name === 'send_to_session') {
      const sessionId = typeof args.session_id === 'string' ? args.session_id : '';
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!sessionId || !text) return 'error: session_id and text are required';
      // Tenant-scoped insert: only succeeds for a live session in this account.
      const res = await insertSessionMessage({ sessionId, accountId: ctx.accountId, body: text });
      if (!res) return 'error: no such live session for this account';
      ctx.actions.push(`steered session ${shortId(sessionId)}`);
      return 'sent to the session';
    }

    if (name === 'set_afk') {
      if (!isAfkState(args.afk)) {
        return `error: afk must be '${AfkState.ON}' or '${AfkState.OFF}'`;
      }
      // Filter to well-formed UUIDs BEFORE the ::uuid[] cast (a bad id would 500
      // the query). The account_id predicate in the repo is the tenant boundary.
      const ids = Array.isArray(args.session_ids)
        ? args.session_ids.filter(isUuid)
        : [];
      if (ids.length === 0) {
        return 'error: session_ids must be a non-empty array of session ids from LIVE SESSIONS';
      }
      const updated = await setSessionsAfkForAccount({
        accountId: ctx.accountId,
        sessionIds: ids,
        afk: args.afk,
      });
      if (updated.length === 0) {
        return 'error: none of those ids match a live session for this account';
      }
      ctx.actions.push(`set afk=${args.afk} on ${updated.length} session(s)`);
      const missed = ids.length - updated.length;
      const missedNote = missed > 0 ? `; ${missed} id(s) matched no live session` : '';
      return `set afk=${args.afk} on ${updated.length} session(s)${missedNote}`;
    }

    if (name === 'respond_to_request') {
      const requestId = typeof args.request_id === 'string' ? args.request_id : '';
      if (!requestId) return 'error: request_id is required';
      const target = await resolveTarget(requestId, ctx.accountId, ctx.pending);
      if (!target) return 'error: no such pending request';

      switch (args.action) {
        case RequestAction.ANSWER: {
          const text = typeof args.text === 'string' ? args.text.trim() : '';
          const dec = await resolveAttention({
            accountId: ctx.accountId,
            attentionId: target.id,
            answerText: text,
            source: DecisionSource.PHONE,
          });
          if (!dec) return 'error: that request is already resolved';
          ctx.actions.push(`answered ${target.kind} ${shortId(target.id)}`);
          return 'answered';
        }

        case RequestAction.APPROVE: {
          if (!actionAllowedForKind(RequestAction.APPROVE, target.kind)) {
            return "error: action='approve' is for plans only (use answer/allow/deny otherwise)";
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

        case RequestAction.DENY: {
          const dec = await resolveAttention({
            accountId: ctx.accountId,
            attentionId: target.id,
            behavior: DecisionBehavior.DENY,
            source: DecisionSource.PHONE,
          });
          if (!dec) return 'error: that request is already resolved';
          ctx.actions.push(`denied ${target.kind} ${shortId(target.id)}`);
          return 'denied';
        }

        case RequestAction.ALLOW: {
          if (!actionAllowedForKind(RequestAction.ALLOW, target.kind)) {
            return "error: action='allow' is for permissions (use answer for a question, approve for a plan)";
          }
          // A destructive allow requires PROOF the user was shown a code-generated,
          // accurate notification for THIS request: notify_message_id is set only by
          // the system (notifyStatic / surfaceRequestMessage), never by LLM prose
          // (see text_user). If it's missing (notification lost on a restart, or
          // never sent because the user wasn't AFK at creation), don't approve an op
          // the user never saw described — instead SURFACE it now (posts the accurate
          // description AND sets notify_message_id), then have them tap-back it. That
          // both shows the description and bootstraps the binding — strictly better
          // than dead-ending at "use the keyboard" when the user is away.
          if (isDestructiveTool(target.toolName) && !target.notifyMessageId) {
            await surfaceRequestMessage(ctx, target);
            return 'refused: that request had not been shown to you with a description yet — I just posted it as a fresh message. Ask the user to TAP-BACK 👍 (allow) / 👎 (deny) on THAT message to approve it.';
          }
          // THE GATE: destructive allows require a deterministic binding. The model
          // names a target; we only treat it as deterministic if it IS the bound one.
          const binding =
            ctx.boundTarget && ctx.boundTarget.id === target.id ? 'deterministic' : 'inferred';
          const check = checkDestructiveAllow(target, binding);
          if (!check.permitted) {
            // CODE BACKSTOP for the approve-loop: the only tap-backable target
            // for a destructive permission is a system-posted notification, and
            // the original one has usually scrolled away. Re-post it now (and
            // move the binding onto the fresh message) so a tap-back has
            // something to land on — don't rely on the model remembering to call
            // surface_request. Then point the user at THAT message; never tell
            // them to "reply" (a typed reply carries no link — see safety.ts).
            await surfaceRequestMessage(ctx, target);
            return `refused: ${check.reason}. I re-posted that exact request as a fresh message — ask the user to TAP-BACK 👍 (allow) / 👎 (deny) on THAT message (not your prose; a typed reply cannot bind).`;
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
          return `error: unknown action ${String(args.action)} (use answer/approve/deny/allow)`;
      }
    }

    return `error: unknown tool ${name}`;
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

/**
 * Re-post a pending request as a FRESH, tap-backable message during a
 * user-message turn and move its tap-back binding onto that new message. The
 * user-turn analog of notifyStatic: the body is the CODE-generated
 * composeNotification (an accurate description — the safety invariant that a
 * destructive tap-back only ever fronts code-generated prose, see text_user),
 * NOT anything the model wrote. This is what lets a destructive permission be
 * approved by tap-back at all — the original notification scrolls away, and the
 * model's own "tap-back this" prose is deliberately unbindable, so without a
 * fresh code-posted target every reaction misses and the user loops. Returns the
 * new provider message id, or undefined if delivery failed. Best-effort.
 */
async function surfaceRequestMessage(
  ctx: DispatchCtx,
  target: AttentionEvent,
): Promise<string | undefined> {
  const id = await sendToUser(ctx.transport, ctx.accountId, composeNotification(target), {
    replyToMessageId: ctx.inbound?.messageId,
    fallbackTo: ctx.inbound?.from,
  });
  if (id) {
    ctx.sent.count += 1;
    await setAttentionNotifyMessageId(target.id, id, ctx.accountId).catch(() => {});
  }
  return id;
}

function composeNotification(event: AttentionEvent): string {
  const head =
    event.kind === AttentionKind.PERMISSION
      ? `Permission needed${event.toolName ? ` (${event.toolName})` : ''}`
      : event.kind === AttentionKind.PLAN
        ? 'Plan ready for review'
        : 'Question';
  const detail = event.description || event.inputPreview || '';
  const base = detail ? `${head}: ${detail}` : head;
  // A PERMISSION is the binding-gated kind: from the phone it can only be
  // approved by a TAP-BACK on THIS message (a typed reply carries no link to it
  // — see safety.ts). This notification's own provider id becomes the
  // attention's notifyMessageId, so a tap-back here binds deterministically.
  // Spell out the gesture (and which reaction means what) so the user is never
  // left guessing how to act — the gap that produced the approve-loop.
  if (event.kind === AttentionKind.PERMISSION) {
    return `${base}\n\nTap-back this message to act: 👍 allow, 👎 deny.`;
  }
  return base;
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
 * same pending attentions). Back-to-back texts are additionally COALESCED on top
 * of this lock (see the inbound-coalescing section below). In-process only —
 * correct for a single instance; a multi-instance deployment would need a
 * Postgres advisory lock.
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

// --- back-to-back inbound coalescing (in-process) -----------------------------
//
// Goal (single agent per number): when the user fires several texts in quick
// succession, don't answer each one. While a turn is still UNCOMMITTED (waiting
// on the model, nothing sent/acted), a newly-arrived text INTERRUPTS it and the
// two are re-run as ONE combined turn — so a typo correction folds into the same
// reply. Once a turn has committed a side effect (it replied, or resolved/steered
// /set-afk something) it always finishes, and the new text runs as its own turn.
//
// Buffered inbound per account, drained by one loop at a time. The loop runs
// inside withAccountLock so user turns stay serialized with the agent-event /
// status-relay turns. In-process only (same scope as withAccountLock); a
// multi-instance deployment would need a Postgres-backed queue + advisory lock.

/**
 * Max times an uncommitted free-text turn may be INTERRUPTED by a newer text
 * before the next pass is forced to run to completion. Bounds coalescing so a
 * steady trickle of quick lines ("wait", "no", "actually…") can't keep the turn
 * perpetually uncommitted and starve the reply. After the cap, the next pass is
 * non-interruptible (still folds in everything queued so far), then commits.
 */
const MAX_COALESCE_INTERRUPTS = 5;

/** Undrained inbound messages per account (FIFO; shared reference, mutated in place). */
const userQueues = new Map<string, InboundMessage[]>();
/** Accounts with a drain loop currently running/scheduled (the synchronous guard
 *  that prevents two concurrent drains and lost wakeups). */
const drainActive = new Set<string>();
/** The in-flight user turn per account, for interrupt-coalescing. */
const inflightUserTurn = new Map<string, InflightTurn>();

interface InflightTurn {
  abort: AbortController;
  /** Latches true once the turn performs a side effect; an interrupt is ignored
   *  after that (a committed turn always finishes). */
  commit: { committed: boolean };
  /** False for a tap-back batch (each runs its own turn so its deterministic
   *  binding is preserved) and for a pass that hit MAX_COALESCE_INTERRUPTS. */
  interruptible: boolean;
}

/**
 * Should a freshly-arrived inbound INTERRUPT the in-flight turn to coalesce with
 * it? Pure decision (exported for tests). Only an uncommitted, interruptible
 * in-flight turn yields to a FREE-TEXT message; a tap-back / inline reply never
 * interrupts — it runs its own turn so its explicit binding isn't merged away.
 */
export function shouldInterrupt(
  inflight: InflightTurn | undefined,
  incoming: Pick<InboundMessage, 'reactionTo'>,
): boolean {
  if (!inflight) return false;
  if (!inflight.interruptible) return false;
  if (inflight.commit.committed) return false;
  if (incoming.reactionTo) return false;
  return true;
}

/**
 * Pull the next batch off the FIFO queue (mutates it). A tap-back / inline reply
 * is ALWAYS its own batch (so two distinct explicit bindings never merge into one
 * turn and silently drop one); otherwise coalesce the leading run of free-text
 * messages up to — but not including — the next tap-back. Pure (exported for
 * tests). Returns [] only for an empty queue.
 */
export function takeBatch(queue: InboundMessage[]): InboundMessage[] {
  const head = queue[0];
  if (!head) return [];
  if (head.reactionTo) return queue.splice(0, 1);
  let n = 1;
  for (; n < queue.length; n++) {
    const m = queue[n];
    if (!m || m.reactionTo) break;
  }
  return queue.splice(0, n);
}

/**
 * Enqueue an inbound user message and ensure a drain loop is running. If a drain
 * is already active, interrupt its in-flight turn when `shouldInterrupt` says so
 * (uncommitted free-text coalescing); otherwise the message is picked up on the
 * next drain iteration (the "already replied" / tap-back / capped cases).
 */
function enqueueUserMessage(
  accountId: string,
  inbound: InboundMessage,
  transport: Transport,
): void {
  const q = userQueues.get(accountId) ?? [];
  q.push(inbound);
  userQueues.set(accountId, q);

  if (drainActive.has(accountId)) {
    const inflight = inflightUserTurn.get(accountId);
    if (inflight && shouldInterrupt(inflight, inbound)) {
      inflight.abort.abort(); // interrupt → coalesce with this message
    }
    return;
  }

  // No drain running: start one under the per-account lock (so user turns stay
  // serialized with the agent-event / status-relay turns).
  drainActive.add(accountId);
  void withAccountLock(accountId, () => drainUserQueue(accountId, transport));
}

/**
 * Drain an account's inbound queue, one batch at a time, until empty. Each pass
 * takes the next batch (a free-text run, or a lone tap-back — see takeBatch). An
 * interrupted (uncommitted) turn re-queues its batch ahead of the newer
 * message(s) so the next pass coalesces them in arrival order; consecutive
 * interrupts are capped so the reply can't be starved.
 */
async function drainUserQueue(accountId: string, transport: Transport): Promise<void> {
  let interrupts = 0;
  try {
    for (;;) {
      const queue = userQueues.get(accountId);
      // Empty → tear down. This check + the delete run in ONE synchronous tick
      // (no await before the next enqueue can observe it), so a message can't
      // slip in after we decide to stop (no lost wakeup) and a second drain
      // can't start while this one is alive (no double drain).
      if (!queue || queue.length === 0) {
        userQueues.delete(accountId);
        return; // `finally` clears drainActive in this same tick.
      }
      const batch = takeBatch(queue);

      const abort = new AbortController();
      const commit = { committed: false };
      // A tap-back batch never coalesces; a free-text batch is interruptible
      // until it has been re-queued MAX_COALESCE_INTERRUPTS times (then forced).
      const interruptible =
        batch.length > 0 && !batch[0]?.reactionTo && interrupts < MAX_COALESCE_INTERRUPTS;
      inflightUserTurn.set(accountId, { abort, commit, interruptible });
      let aborted = false;
      try {
        const res = await runUserTurn(batch, transport, accountId, abort.signal, commit);
        aborted = res.aborted === true;
      } catch (err) {
        // runUserTurn is fail-closed and shouldn't throw; if it does (e.g. the
        // DB was unreachable for BOTH its prologue and the clarify send), drop
        // this batch rather than stranding the loop. The webhook claim is
        // already committed, so there's no redelivery — at-most-once, accepted.
        // Last-ditch: still try to tell the user something went wrong.
        console.error('[assistant] drain: user turn threw; dropping batch', err);
        await sendToUser(
          transport,
          accountId,
          "Sorry — something went wrong handling your message. Please try again.",
        ).catch(() => {});
      } finally {
        inflightUserTurn.delete(accountId);
      }
      if (aborted) {
        // Re-queue ahead of the newer message(s) that triggered the abort, and
        // count the interrupt toward the cap so a trickle eventually commits.
        interrupts += 1;
        const q = userQueues.get(accountId) ?? [];
        q.unshift(...batch);
        userQueues.set(accountId, q);
      } else {
        interrupts = 0; // committed (or no-op): fresh budget for the next batch
      }
    }
  } finally {
    // ALWAYS release the drain slot, even on an unexpected throw, so the account
    // never deadlocks — a later inbound restarts the drain (and picks up any
    // messages left queued).
    drainActive.delete(accountId);
  }
}
