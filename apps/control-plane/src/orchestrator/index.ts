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
 * ROUTING + SAFETY (the model decides; the code no longer locks or binds):
 *   - Plain `message_agent` text is ALWAYS a steer — a session waiting on a relayed
 *     question simply receives the steer and treats it as the answer. There is no
 *     code-level "this text resolves that question" auto-binding.
 *   - allow/deny/approve are the structured verdicts; the LLM has FINAL SAY on a
 *     destructive `allow` (no deterministic-binding gate). A tap-back reaction and a
 *     single-pending count are surfaced as HINTS the model weighs (see safety.ts
 *     `deterministicTarget`), never a hard refusal. `surface_request` stays available
 *     to post a clean, tappable request when the model wants one.
 *   - The agent-driven turns expose only `message_user` (notify; the human resolves).
 * Fail-closed everywhere: a turn error sends a safe clarify (user path) or falls
 * back to the static notification (agent-event path) — never an unsafe action.
 */
import {
  ActivityKind,
  AfkState,
  AttentionKind,
  DecisionBehavior,
  RequestAction,
  ToolName,
  isAfkState,
  isUuid,
  type AttentionEvent,
  type InboundMessage,
  type SessionInfo,
} from '@imsg/shared';
import type { Transport } from '@imsg/transport';
import {
  consumeOnboardingTokenAndLinkNumber,
  enqueueReply,
  findAccountByPhone,
  findVerifiedPhoneForAccount,
  getAttentionForAccount,
  getSessionActivity,
  isInboxDelivered,
  listLiveSessionsForAccount,
  listPendingAttentionForAccount,
  logMessage,
  recentMessages,
  resolveAttention,
  setAttentionNotifyMessageId,
  setDevicesAfkForSessions,
  type ReapedSession,
  type SessionActivityLine,
} from '../db/repo.ts';
import { waitForDelivered } from '../db/listener.ts';
import { hashToken } from '../auth/device.ts';
import { runAssistantTurn, type ToolExecutor } from './llm.ts';
import { assistantTools, buildTurnMessages, type TurnMode } from './prompt.ts';
import {
  deterministicTarget,
  isDestructiveTool,
  isPermissionAttention,
} from './safety.ts';

const HISTORY_LIMIT = 20;

/** How long the per-turn delivery watcher waits for the device to ACK that it
 *  injected a row before warning the user. 30s — generous enough that a healthy
 *  device (sub-second) never trips it, so a fired warning means a real problem.
 *  Detached from the turn, so it never blocks the per-account lock. */
const DELIVERY_CONFIRM_TIMEOUT_MS = 30_000;

/** One session_inbox row the turn enqueued, watched for the device's ACK. */
interface DeliveryWatch {
  id: string;
  /** Short human phrase for the warning (e.g. "your answer"). */
  label: string;
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
      sessions,
      boundTarget,
      actions,
      sent,
      deliveries: [],
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
    // Confirm delivery OUT OF BAND: a DETACHED watcher waits up to 30s for the
    // device to ACK each row this turn enqueued, and texts the user a ⚠️ ONLY for
    // anything still unconfirmed (silent on success — no per-message noise). The
    // message is sent to the agent ONCE (the device dedups by id); the wire may
    // re-serve to recover a dropped frame, but the agent never sees a duplicate.
    // Detached (not awaited) so it never holds the per-account lock.
    if (ctx.deliveries.length > 0) {
      void watchDeliveries(accountId, transport, ctx.deliveries);
    }
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
      deliveries: [],
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
  message: { sessionId: string; text: string; expectsReply?: boolean },
  accountId: string,
  transport: Transport,
): Promise<TurnResult> {
  // Serialized per account, same as every other turn (see withAccountLock) so a
  // relay can't interleave with a user turn and double-act on pending requests.
  return withAccountLock(accountId, () => relayAgentMessageLocked(message, accountId, transport));
}

async function relayAgentMessageLocked(
  message: { sessionId: string; text: string; expectsReply?: boolean },
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
      deliveries: [],
    };
    const messages = buildTurnMessages({
      trigger: {
        kind: 'agent_message',
        sessionId: message.sessionId,
        text: message.text,
        expectsReply: message.expectsReply,
      },
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
  /** session_inbox rows enqueued this turn, watched AFTER the turn for the
   *  device's ACK (the 30s warn-only confirmation). See watchDeliveries. */
  deliveries: DeliveryWatch[];
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
 * message_agent: send a message to a coding agent. Plain text is ALWAYS a steer —
 * "just text back and forth". A session that was waiting on a relayed question
 * simply receives the steer and treats it as the answer; there is no code-level
 * auto-binding of "this text resolves that question" (the model decides what its
 * text means, and `expect_reply` is only a hint — see prompt.ts). An `action` is the
 * one structured path: a permission verdict (allow/deny) or a plan approval.
 */
async function execMessageAgent(ctx: DispatchCtx, args: Record<string, unknown>): Promise<string> {
  const sessionId = typeof args.session === 'string' ? args.session.trim() : '';
  if (!sessionId) return 'error: session is required';
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  const action = typeof args.action === 'string' ? args.action : '';

  if (action) return resolveSessionAction(ctx, sessionId, action);

  if (!text) return 'error: pass text (a message to the agent) or an action';

  // Tenant-scoped enqueue: only succeeds for a live session in this account.
  const res = await enqueueReply({ sessionId, accountId: ctx.accountId, text });
  if (!res) return 'error: no such live session for this account';
  ctx.actions.push(`messaged session ${shortId(sessionId)}`);
  ctx.deliveries.push({ id: res.id, label: `your message to ${shortId(sessionId)}` });
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
    });
    if (!dec) return 'error: that request is already resolved';
    ctx.actions.push(`denied ${target.kind} ${shortId(target.id)}`);
    ctx.deliveries.push({ id: dec.inboxId, label: 'the denial' });
    return queuedForSession('denial recorded');
  }

  if (action === RequestAction.APPROVE) {
    const plans = ctx.pending.filter((e) => e.sessionId === sessionId && e.kind === AttentionKind.PLAN);
    if (plans.length === 0) {
      return 'error: that agent has no plan to approve (just send text to answer a question, or use action=allow for a permission)';
    }
    const target = pickStrict(ctx, plans) ?? plans[plans.length - 1]!;
    const dec = await resolveAttention({
      accountId: ctx.accountId,
      attentionId: target.id,
      behavior: DecisionBehavior.ALLOW,
    });
    if (!dec) return 'error: that plan is already resolved';
    ctx.actions.push(`approved plan ${shortId(target.id)}`);
    ctx.deliveries.push({ id: dec.inboxId, label: 'the plan approval' });
    return queuedForSession('plan approved');
  }

  return `error: unknown action ${String(action)} (use allow, deny, or approve — or just send text)`;
}

/**
 * Allow a permission. The LLM has FINAL SAY — there is no deterministic-binding
 * gate (per the user's "drop binding everywhere"). The tap-back / single-pending
 * signal is handed to the model as a HINT (see prompt.ts + `deterministicTarget`),
 * and the model may still `surface_request` to post a clean tappable request, but
 * neither is required to allow — even a destructive op.
 */
async function allowPermission(ctx: DispatchCtx, target: AttentionEvent): Promise<string> {
  const dec = await resolveAttention({
    accountId: ctx.accountId,
    attentionId: target.id,
    behavior: DecisionBehavior.ALLOW,
  });
  if (!dec) return 'error: that permission is already resolved';
  ctx.actions.push(`allowed ${target.toolName ?? 'permission'} ${shortId(target.id)}`);
  ctx.deliveries.push({ id: dec.inboxId, label: 'the permission' });
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
      return (
        `- id=${s.id} title=${sessionTitle(s.title)} state=${s.state} afk=${s.afk}` +
        `${s.cwd ? ` cwd=${clip(s.cwd, 80)}` : ''}; ${blockedNote}`
      );
    })
    .join('\n');
}

/** get_session_data: the one read tool for agent activity. Two modes:
 *   - NO ids  → list every live session as a compact `id + title` pick-list, so
 *     the model can discover which sessions exist before reading any (thin
 *     harness: discovery lives on the same tool, not a separate one).
 *   - one+ ids → read each named agent's activity log (recent / grep / line
 *     range), grouped under a per-session header. The limit/grep/range options
 *     apply per session. */
async function execGetSessionData(ctx: DispatchCtx, args: Record<string, unknown>): Promise<string> {
  const ids = collectSessionIds(args);

  // No ids → list mode: every live session as `id + title`, the minimum the
  // model needs to then call this same tool with the ids it wants to read.
  if (ids.length === 0) {
    if (ctx.sessions.length === 0) return 'no live sessions';
    return ctx.sessions.map((s) => `- id=${s.id} title=${sessionTitle(s.title)}`).join('\n');
  }

  // Fetch mode: read each id's log into its own labelled block. Per-session
  // queries (not a single batched one) keep one bad/empty id from masking the
  // rest, and let each block carry its own line-numbered range for re-slicing.
  const opts = {
    accountId: ctx.accountId,
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(typeof args.grep === 'string' && args.grep.trim() ? { grep: args.grep } : {}),
    ...(typeof args.from_line === 'number' ? { fromLine: args.from_line } : {}),
    ...(typeof args.to_line === 'number' ? { toLine: args.to_line } : {}),
  };
  const blocks = await Promise.all(
    ids.map(async (sessionId) => {
      const known = ctx.sessions.find((s) => s.id === sessionId);
      const header = `=== session ${sessionId} title=${sessionTitle(known?.title)} ===`;
      // Guard the ::uuid comparison: a malformed id would error the query and
      // (via Promise.all) take down the whole batch. Skip it with a note instead.
      if (!isUuid(sessionId)) return `${header}\nerror: not a valid session id`;
      const rows = await getSessionActivity({ sessionId, ...opts });
      const body = rows.length === 0 ? 'no matching activity for this session' : rows.map(formatActivityLine).join('\n');
      return `${header}\n${body}`;
    }),
  );
  return blocks.join('\n\n');
}

/** Normalize get_session_data's target ids → trimmed, non-empty, de-duped. Forgiving
 *  of how the model phrases it: `session_ids` as an array (canonical) or a lone
 *  string, plus a single `session` string (tolerated alias). */
function collectSessionIds(args: Record<string, unknown>): string[] {
  const fromIds = Array.isArray(args.session_ids)
    ? args.session_ids
    : typeof args.session_ids === 'string'
      ? [args.session_ids]
      : [];
  const fromSingle = typeof args.session === 'string' ? [args.session] : [];
  const cleaned = [...fromIds, ...fromSingle]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return [...new Set(cleaned)];
}

/** A session title for tool output: the quoted title, or `(untitled)`. */
function sessionTitle(title: string | undefined): string {
  return title ? JSON.stringify(clip(title, 80)) : '(untitled)';
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

// -----------------------------------------------------------------------------
// "Lost connection" notification (reaper-driven).
// -----------------------------------------------------------------------------

/** One ended session, resolved to its display label. */
export interface EndedSessionItem {
  id: string;
  title: string | null;
}

/** Build the coalesced "lost connection" iMessage. Pure + deterministic (no LLM).
 *  Per product decision this names the session(s) only — NO activity summary, so a
 *  dropped laptop never leaks its last transcript line to the phone. Exported for
 *  unit tests. */
export function composeSessionsEndedMessage(items: ReadonlyArray<EndedSessionItem>): string {
  // clip the title: it's device-sanitized but keep one line per session (a stray
  // newline would split a bullet).
  const label = (it: EndedSessionItem): string =>
    it.title?.trim() ? clip(it.title, 80) : shortId(it.id);
  const [first] = items;
  if (items.length === 1 && first) {
    return `Lost connection with session "${label(first)}".`;
  }
  const lines = items.map((it) => `• ${label(it)}`);
  return `Lost connection with ${items.length} sessions:\n${lines.join('\n')}`;
}

/**
 * Notify the user that one or more of their sessions ENDED while AFK. Driven by
 * the liveness reaper — the authoritative server-side death detector, because the
 * device can't announce a SIGKILL / crash / sleep. AFK-gated: a session is
 * surfaced only if its device is afk='on' (at the keyboard the dashboard already
 * shows live state). Coalesced into ONE iMessage per account, so closing a laptop
 * running N worktree-sessions is a single text, not N. Code-generated +
 * deterministic (no LLM turn, no attention row). Best-effort — never throws into
 * the reaper timer.
 */
export async function notifyEndedSessions(
  transport: Transport,
  reaped: ReadonlyArray<ReapedSession>,
): Promise<void> {
  const afkEnded = reaped.filter((s) => s.afk === AfkState.ON);
  if (afkEnded.length === 0) return;

  // afk is machine-wide, but the user (and their phone number) is per-account.
  const byAccount = new Map<string, ReapedSession[]>();
  for (const s of afkEnded) {
    const list = byAccount.get(s.accountId);
    if (list) list.push(s);
    else byAccount.set(s.accountId, [s]);
  }

  for (const [accountId, sessions] of byAccount) {
    try {
      const items: EndedSessionItem[] = sessions.map((s) => ({ id: s.id, title: s.title }));
      // sendToUser is itself best-effort (logs + swallows transport errors).
      await sendToUser(transport, accountId, composeSessionsEndedMessage(items));
    } catch (err) {
      console.error('[reaper] notify ended sessions failed', err);
    }
  }
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

/**
 * DETACHED per-turn delivery watcher. Waits up to DELIVERY_CONFIRM_TIMEOUT_MS for
 * the device to ACK that it injected each session_inbox row this turn enqueued
 * (session_inbox.delivered_at, set on the ACK). Texts the user a single ⚠️ ONLY
 * for rows still unconfirmed at the deadline — SILENT on success (a healthy device
 * ACKs sub-second, so a fired warning means a real problem). Runs off the
 * per-account lock (spawned with `void`); best-effort, never throws out.
 */
async function watchDeliveries(
  accountId: string,
  transport: Transport,
  deliveries: ReadonlyArray<DeliveryWatch>,
): Promise<void> {
  try {
    const results = await Promise.all(
      deliveries.map(async (d) => ({
        label: d.label,
        ok: await waitForDelivered(d.id, DELIVERY_CONFIRM_TIMEOUT_MS, () =>
          isInboxDelivered({ id: d.id, accountId }),
        ),
      })),
    );
    const followup = composeDeliveryFollowup(results.filter((r) => !r.ok).map((r) => r.label));
    if (followup) await sendToUser(transport, accountId, followup);
  } catch (err) {
    console.error('[assistant] delivery watch error', err);
  }
}

/**
 * Compose the unconfirmed-delivery warning (CODE-generated — never LLM prose, so
 * it's always truthful). Returns undefined when everything was confirmed (SILENT
 * on success). `unconfirmed` are the rows the device didn't ACK within the window.
 * Exported for tests.
 */
export function composeDeliveryFollowup(unconfirmed: ReadonlyArray<string>): string | undefined {
  if (unconfirmed.length === 0) return undefined;
  const secs = Math.round(DELIVERY_CONFIRM_TIMEOUT_MS / 1000);
  return `⚠️ Heads up — I couldn't confirm ${joinLabels(unconfirmed)} reached the session (no ack after ${secs}s). It may still have landed; I just can't confirm it.`;
}

/** Join labels into a natural list ("a", "a and b", "a, b and c"). */
function joinLabels(labels: ReadonlyArray<string>): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
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
