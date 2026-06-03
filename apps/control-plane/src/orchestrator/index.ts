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
 *     — `message_agent` (action `allow`) checks `deterministicTarget()` +
 *     `checkDestructiveAllow()`, refuses else.
 *   - The model can never mint a FULL grant (`capGrant` caps to EDITS).
 *   - The agent-driven turns expose only `message_user` (notify; the human resolves).
 * Fail-closed everywhere: a turn error sends a safe clarify (user path) or falls
 * back to the static notification (agent-event path) — never an unsafe action.
 */
import {
  ActivityKind,
  AfkState,
  AttentionKind,
  DecisionBehavior,
  DecisionSource,
  GrantLevel,
  RequestAction,
  ToolName,
  isAfkState,
  isGrantLevel,
  isUuid,
  type AttentionEvent,
  type InboundMessage,
  type SessionInfo,
} from '@imsg/shared';
import type { Transport } from '@imsg/transport';
import {
  consumeOnboardingTokenAndLinkNumber,
  findAccountByPhone,
  findVerifiedPhoneForAccount,
  getAttentionForAccount,
  getSessionActivity,
  insertSessionMessage,
  listLiveSessionsForAccount,
  listPendingAttentionForAccount,
  logMessage,
  recentMessages,
  resolveAttention,
  setAttentionNotifyMessageId,
  setDevicesAfkForSessions,
  type SessionActivityLine,
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
      sessions,
      boundTarget,
      actions,
      sent,
    };
    const messages = buildTurnMessages({
      trigger: { kind: 'user_message', inbounds: batch },
      pending,
      sessions,
      history,
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
      sessions,
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
      sessions,
      actions,
      sent,
    };
    const messages = buildTurnMessages({
      trigger: { kind: 'agent_message', sessionId: message.sessionId, text: message.text },
      pending,
      sessions,
      history,
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
    // A status relay is NOT guaranteed delivery: the assistant may judge an update
    // trivial and stay silent (the user asked for "don't text unless necessary").
    // So no forced forward on a silent happy-path turn — only the catch below
    // raw-forwards, and only when a turn ERROR (not a deliberate silence) would
    // otherwise eat a real update.
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
  /** Live sessions snapshot for this account (backs get_session_state). */
  sessions: ReadonlyArray<SessionInfo>;
  /** Deterministic binding for the destructive-allow gate (user-message turns). */
  boundTarget?: AttentionEvent;
  /** Default tap-back binding target for message_user (agent-event turns). */
  triggerAttentionId?: string;
  /** Recorded action notes (folded into history for multi-turn coherence). */
  actions: string[];
  /** Count of outbound messages sent this turn. */
  sent: { count: number };
}

/** Build the tool executor for one turn. Tools never throw — they return `error:`.
 *  message_user is available on every turn; message_agent / get_session_state /
 *  get_session_data / update_session_state are user-message turns only. */
function makeExecTool(ctx: DispatchCtx): ToolExecutor {
  return async (name, args) => {
    // message_user is the one tool available on every turn (the only one on the
    // two notify-only agent-driven turns).
    if (name === ToolName.MESSAGE_USER) return execMessageUser(ctx, args);

    // Messaging an agent, reading state/log, and changing a setting are user-message
    // only — the human drives these. Both agent-driven turns are notify-only.
    if (ctx.mode !== 'user_message') {
      return 'error: only message_user is available here; notify the user and let them decide';
    }

    switch (name) {
      case ToolName.MESSAGE_AGENT:
        return execMessageAgent(ctx, args);
      case ToolName.GET_SESSION_STATE:
        return execGetSessionState(ctx, args);
      case ToolName.GET_SESSION_DATA:
        return execGetSessionData(ctx, args);
      case ToolName.UPDATE_SESSION_STATE:
        return execUpdateSessionState(ctx, args);
      default:
        return `error: unknown tool ${name}`;
    }
  };
}

/**
 * message_user: text the user, and/or surface a pending request as a fresh,
 * tap-backable message. At least one of `text` / `surface_request` is required.
 * Surfacing posts the CODE-generated notification (never LLM prose) and moves the
 * tap-back binding onto it — the only way a destructive permission can be approved.
 */
async function execMessageUser(ctx: DispatchCtx, args: Record<string, unknown>): Promise<string> {
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  const surfaceId = typeof args.surface_request === 'string' ? args.surface_request.trim() : '';
  if (!text && !surfaceId) return 'error: pass text and/or surface_request';

  const out: string[] = [];

  if (surfaceId) {
    const target = await resolveTarget(surfaceId, ctx.accountId, ctx.pending);
    if (!target) {
      out.push('surface_request: no such pending request');
    } else {
      const id = await surfaceRequestMessage(ctx, target);
      if (!id) {
        out.push('surface_request: could not deliver (no verified phone on file)');
      } else {
        ctx.actions.push(`surfaced ${target.kind} ${shortId(target.id)} for tap-back`);
        out.push('surfaced — ask the user to TAP-BACK 👍 allow / 👎 deny on that message');
      }
    }
  }

  if (text) {
    const id = await sendToUser(ctx.transport, ctx.accountId, text, {
      replyToMessageId: ctx.inbound?.messageId,
      fallbackTo: ctx.inbound?.from,
    });
    // Count only ACTUAL deliveries: a failed send must not suppress the agent-event
    // static fallback (sent.count === 0).
    if (id) ctx.sent.count += 1;
    // about_request is LLM-provided; the write is account-scoped (repo) so it can't
    // touch another tenant. We refuse to bind a tap-back to a DESTRUCTIVE permission:
    // that binding must only ever front a code-generated, accurate notification
    // (surfaceRequestMessage), never LLM prose. Non-destructive binds are safe.
    const about =
      typeof args.about_request === 'string' && args.about_request
        ? args.about_request
        : ctx.triggerAttentionId;
    if (about && id) {
      const a = ctx.pending.find((e) => e.id === about);
      if (!a || !isPermissionAttention(a) || !isDestructiveTool(a.toolName)) {
        await setAttentionNotifyMessageId(about, id, ctx.accountId).catch(() => {});
      }
    }
    out.push(id ? 'sent' : 'error: could not deliver (no verified phone on file)');
  }

  return out.join('; ');
}

/**
 * message_agent: send a message to a coding agent. Plain text is "just text back
 * and forth" — if the agent is blocked on a question/plan that text IS the answer
 * (resolve it, so it leaves the pending pile and the agent's expect_reply matches),
 * otherwise it's a steer. An `action` is the one structured path: a permission
 * verdict (allow/deny) or a plan approval, gated in code for destructive allows.
 */
async function execMessageAgent(ctx: DispatchCtx, args: Record<string, unknown>): Promise<string> {
  const sessionId = typeof args.session === 'string' ? args.session.trim() : '';
  if (!sessionId) return 'error: session is required';
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  const action = typeof args.action === 'string' ? args.action : '';

  if (action) return resolveSessionAction(ctx, sessionId, action, args.grant);

  if (!text) return 'error: pass text (a message to the agent) or an action';

  const answerable = pickSessionTarget(ctx, sessionId, [AttentionKind.QUESTION, AttentionKind.PLAN]);
  if (answerable) {
    const dec = await resolveAttention({
      accountId: ctx.accountId,
      attentionId: answerable.id,
      answerText: text,
      source: DecisionSource.PHONE,
    });
    if (dec) {
      ctx.actions.push(`answered ${answerable.kind} ${shortId(answerable.id)}`);
      return queuedForSession('answer recorded');
    }
    // Raced to resolved between snapshot and now — fall through to a plain steer.
  }

  // Tenant-scoped insert: only succeeds for a live session in this account.
  const res = await insertSessionMessage({ sessionId, accountId: ctx.accountId, body: text });
  if (!res) return 'error: no such live session for this account';
  ctx.actions.push(`messaged session ${shortId(sessionId)}`);
  return queuedForSession('message sent');
}

/**
 * The structured verdicts on message_agent: allow/deny a permission, approve a plan.
 * Keyed by SESSION (no request id): the target is the tap-back-bound one if a
 * reaction picked it, else the session's single candidate of that kind, else
 * ambiguous (ask). A destructive allow additionally passes the binding gate.
 */
async function resolveSessionAction(
  ctx: DispatchCtx,
  sessionId: string,
  action: string,
  grantArg: unknown,
): Promise<string> {
  if (action === RequestAction.ALLOW) {
    const perms = ctx.pending.filter((e) => e.sessionId === sessionId && isPermissionAttention(e));
    if (perms.length === 0) return 'error: that agent has no permission waiting to allow';
    const target = pickStrict(ctx, perms);
    if (!target) {
      return 'error: more than one permission is pending for that agent — ask the user which, and surface each for a tap-back';
    }
    return allowPermission(ctx, target);
  }

  if (action === RequestAction.DENY) {
    // Deny is always safe — target the bound/single pending, else the most-recent
    // (a deny can never approve the wrong thing).
    const cands = ctx.pending.filter((e) => e.sessionId === sessionId);
    if (cands.length === 0) return 'error: that agent has nothing pending to deny';
    const target = pickStrict(ctx, cands) ?? cands[cands.length - 1]!;
    const dec = await resolveAttention({
      accountId: ctx.accountId,
      attentionId: target.id,
      behavior: DecisionBehavior.DENY,
      source: DecisionSource.PHONE,
    });
    if (!dec) return 'error: that request is already resolved';
    ctx.actions.push(`denied ${target.kind} ${shortId(target.id)}`);
    return queuedForSession('denial recorded');
  }

  if (action === RequestAction.APPROVE) {
    const plans = ctx.pending.filter((e) => e.sessionId === sessionId && e.kind === AttentionKind.PLAN);
    if (plans.length === 0) {
      return 'error: that agent has no plan to approve (just send text to answer a question, or use action=allow for a permission)';
    }
    const target = pickStrict(ctx, plans) ?? plans[plans.length - 1]!;
    const grant = capGrant(grantArg);
    const dec = await resolveAttention({
      accountId: ctx.accountId,
      attentionId: target.id,
      behavior: DecisionBehavior.ALLOW,
      grant,
      source: DecisionSource.PHONE,
    });
    if (!dec) return 'error: that plan is already resolved';
    ctx.actions.push(`approved plan ${shortId(target.id)}${grant ? ` grant=${grant}` : ''}`);
    return queuedForSession(grant ? `plan approved (standing grant: ${grant})` : 'plan approved');
  }

  return `error: unknown action ${String(action)} (use allow, deny, or approve — or just send text)`;
}

/**
 * The destructive-allow gate, keyed to a specific permission attention. A
 * destructive allow goes through ONLY with a deterministic tap-back binding; else
 * we re-surface the exact request and ask the user to tap-back. (Unchanged contract.)
 */
async function allowPermission(ctx: DispatchCtx, target: AttentionEvent): Promise<string> {
  // Require PROOF the user saw a code-generated, accurate notification for THIS
  // request (notify_message_id is set only by the system — notifyStatic /
  // surfaceRequestMessage — never by LLM prose). If it's missing, surface it now
  // rather than approving an op the user never saw described.
  if (isDestructiveTool(target.toolName) && !target.notifyMessageId) {
    await surfaceRequestMessage(ctx, target);
    return 'refused: I had not shown the user this exact request with a description yet — I just posted it as a fresh message. Ask them to TAP-BACK 👍 allow / 👎 deny on THAT message.';
  }
  // THE GATE: destructive allows require a deterministic binding. The model names a
  // target; we only treat it as deterministic if it IS the bound one.
  const binding =
    ctx.boundTarget && ctx.boundTarget.id === target.id ? 'deterministic' : 'inferred';
  const check = checkDestructiveAllow(target, binding);
  if (!check.permitted) {
    // CODE BACKSTOP for the approve-loop: re-post the request as a fresh, tap-backable
    // message (move the binding onto it) so a tap-back has something to land on, then
    // point the user at THAT message — never tell them to "reply" (a typed reply
    // carries no link — see safety.ts).
    await surfaceRequestMessage(ctx, target);
    return `refused: ${check.reason}. I re-posted that exact request as a fresh message — ask the user to TAP-BACK 👍 allow / 👎 deny on THAT message (a typed reply cannot bind).`;
  }
  const dec = await resolveAttention({
    accountId: ctx.accountId,
    attentionId: target.id,
    behavior: DecisionBehavior.ALLOW,
    source: DecisionSource.PHONE,
  });
  if (!dec) return 'error: that permission is already resolved';
  ctx.actions.push(`allowed ${target.toolName ?? 'permission'} ${shortId(target.id)}`);
  return queuedForSession('permission allowed');
}

/** Pick the unambiguous target among candidates: the deterministically-bound one if
 *  a tap-back chose it, else the lone candidate, else undefined (ambiguous). */
function pickStrict(ctx: DispatchCtx, candidates: AttentionEvent[]): AttentionEvent | undefined {
  const bound = ctx.boundTarget && candidates.find((c) => c.id === ctx.boundTarget!.id);
  if (bound) return bound;
  if (candidates.length === 1) return candidates[0];
  return undefined;
}

/** Pick the target a plain-text message resolves: the bound one, the lone candidate,
 *  else the most-recent of the given kinds (answering text is safe to apply to the
 *  latest question/plan; the destructive gate guards the only unsafe path). */
function pickSessionTarget(
  ctx: DispatchCtx,
  sessionId: string,
  kinds: AttentionKind[],
): AttentionEvent | undefined {
  const candidates = ctx.pending.filter(
    (e) => e.sessionId === sessionId && kinds.includes(e.kind),
  );
  if (candidates.length === 0) return undefined;
  return pickStrict(ctx, candidates) ?? candidates[candidates.length - 1];
}

/** get_session_state: a compact state line per session (one, or all live). */
async function execGetSessionState(ctx: DispatchCtx, args: Record<string, unknown>): Promise<string> {
  const sessionId = typeof args.session === 'string' ? args.session.trim() : '';
  const sessions = sessionId ? ctx.sessions.filter((s) => s.id === sessionId) : ctx.sessions;
  if (sessions.length === 0) {
    return sessionId ? 'no such live session for this account' : 'no live sessions';
  }
  return sessions
    .map((s) => {
      const blocked = ctx.pending.filter((p) => p.sessionId === s.id);
      const blockedNote = blocked.length
        ? `blocked on ${blocked
            .map((b) => `${b.kind}${b.toolName ? `(${b.toolName})` : ''} [id=${b.id}]`)
            .join(', ')}`
        : 'not blocked';
      const title = s.title ? JSON.stringify(clip(s.title, 80)) : '(untitled)';
      return (
        `- id=${s.id} title=${title} state=${s.state} afk=${s.afk} grant=${s.grant}` +
        `${s.cwd ? ` cwd=${clip(s.cwd, 80)}` : ''}; ${blockedNote}`
      );
    })
    .join('\n');
}

/** get_session_data: read an agent's activity log (recent / grep / line range). */
async function execGetSessionData(ctx: DispatchCtx, args: Record<string, unknown>): Promise<string> {
  const sessionId = typeof args.session === 'string' ? args.session.trim() : '';
  if (!sessionId) return 'error: session is required';
  const rows = await getSessionActivity({
    sessionId,
    accountId: ctx.accountId,
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(typeof args.grep === 'string' && args.grep.trim() ? { grep: args.grep } : {}),
    ...(typeof args.from_line === 'number' ? { fromLine: args.from_line } : {}),
    ...(typeof args.to_line === 'number' ? { toLine: args.to_line } : {}),
  });
  if (rows.length === 0) return 'no matching activity for that session';
  return rows.map(formatActivityLine).join('\n');
}

/** update_session_state: change a session setting (afk only, for now). AFK is
 *  MACHINE-WIDE — naming a session flips its whole device (every live session on
 *  it), so this writes devices.afk for each named session's device. */
async function execUpdateSessionState(ctx: DispatchCtx, args: Record<string, unknown>): Promise<string> {
  if (!isAfkState(args.afk)) {
    return `error: afk must be '${AfkState.ON}' or '${AfkState.OFF}'`;
  }
  // Filter to well-formed UUIDs BEFORE the ::uuid[] cast (a bad id would 500 the
  // query). The account_id predicate in the repo is the tenant boundary.
  const ids = Array.isArray(args.session_ids) ? args.session_ids.filter(isUuid) : [];
  if (ids.length === 0) {
    return 'error: session_ids must be a non-empty array of session ids';
  }
  const updated = await setDevicesAfkForSessions({
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
  return `set afk=${args.afk} on ${updated.length} session(s) (machine-wide)${missedNote}`;
}

/** One line per activity event for get_session_data, line-numbered for citing/re-slicing. */
function formatActivityLine(a: SessionActivityLine): string {
  const head = `[${a.lineNo}] `;
  switch (a.kind) {
    case ActivityKind.USER_MESSAGE:
      return `${head}user: ${clip(a.body ?? '', 200)}`;
    case ActivityKind.ASSISTANT_TEXT:
      return `${head}assistant: ${clip(a.body ?? '', 200)}`;
    case ActivityKind.TOOL_USE:
      return a.summary
        ? `${head}tool ${a.toolName}: ${clip(a.summary, 160)}`
        : `${head}tool ${a.toolName ?? ''}`.trimEnd();
    case ActivityKind.TOOL_RESULT:
      return `${head}${a.isError ? 'tool failed' : 'tool ok'}`;
    default:
      return `${head}${a.kind}`;
  }
}

/** Collapse whitespace and truncate — keeps tool results compact and single-line. */
function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
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
 * destructive tap-back only ever fronts code-generated prose, see execMessageUser),
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

/**
 * Honest tool-result for an action whose EFFECT reaches the coding agent
 * ASYNCHRONOUSLY. `message_agent` (a steer, an answer, or a verdict) only writes
 * the decision/steer row and fires the LISTEN/NOTIFY that the device's SSE stream
 * reacts to — it returns the instant that row is durable, NOT when the agent
 * has received or acted on it (no delivery ack is awaited here; the device's
 * `delivered_at`/ACK loop is a separate dedup mechanism). So the record is
 * durable NOW but receipt is unconfirmed. This wording keeps the model from
 * telling the user the agent is already "unblocked"/"resumed" — see the
 * RELAYING IS NOT CONFIRMATION rule in the system prompt.
 */
function queuedForSession(recorded: string): string {
  return `${recorded}; queued for delivery to the session (the agent has NOT confirmed receipt yet)`;
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
