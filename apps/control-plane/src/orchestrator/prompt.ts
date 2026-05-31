/**
 * Orchestrator prompt construction + the LLM action schema.
 *
 * The LLM's ONLY job is to decide intent: which pending attention an inbound
 * reply targets, and what action to take (answer a question, approve/reject a
 * plan, deny a permission, allow a NON-destructive permission, steer with free
 * text, or ask for clarification). It is explicitly told it CANNOT allow a
 * destructive operation — that path is enforced deterministically in code,
 * outside the model, regardless of what it returns.
 */
import {
  DecisionBehavior,
  GrantLevel,
  type AttentionEvent,
  type InboundMessage,
  type SessionInfo,
} from '@imsg/shared';
import type { LlmMessage } from './llm.ts';

/** The action the LLM proposes. Validated by the orchestrator before use. */
export const LlmActionType = {
  /** Answer a pending question/plan attention with free text. */
  ANSWER: 'answer',
  /** Approve a pending plan (ExitPlanMode) attention. */
  APPROVE_PLAN: 'approve_plan',
  /** Deny a pending permission (always safe — fail-closed direction). */
  DENY: 'deny',
  /** Allow a pending permission. ONLY honored by code if non-destructive OR a
   *  deterministic binding exists — never on the model's say-so for Bash/etc. */
  ALLOW: 'allow',
  /** Free-text steering message pushed into the session (no decision). */
  STEER: 'steer',
  /** Ambiguous / cannot safely act — send a clarifying question to the user. */
  CLARIFY: 'clarify',
} as const;
export type LlmActionType = (typeof LlmActionType)[keyof typeof LlmActionType];

/** Structured action returned by the LLM (after validation). */
export interface LlmAction {
  type: LlmActionType;
  /** Pending attention event id the action targets, if any. */
  targetAttentionId?: string;
  /** Text to send to the user (clarify) or into the session (answer/steer). */
  text?: string;
  /** For approve_plan: an optional grant escalation (edits|full). */
  grant?: GrantLevel;
}

const GRANT_VALUES = Object.values(GrantLevel).join(', ');
const BEHAVIOR_VALUES = Object.values(DecisionBehavior).join(', ');
const ACTION_VALUES = Object.values(LlmActionType).join(', ');

/** The system prompt: locks in the safety contract in plain language. */
export function systemPrompt(): string {
  return [
    'You are the orchestrator for an iMessage-driven Claude Code remote-control.',
    'A developer is away from their keyboard (AFK). Their coding agent paused at',
    'one or more "attention" points (a permission prompt, a question, a plan to',
    'approve, an idle nudge, or a turn-complete). The developer just sent a reply',
    'by text. Decide what that reply means and pick exactly one action.',
    '',
    'HARD SAFETY RULES (never violate):',
    `- You may NEVER allow a DESTRUCTIVE operation by inference. Destructive =`,
    `  any permission whose tool is NOT a pure file edit (e.g. Bash, network,`,
    `  deletion). For those you may only ever return "${LlmActionType.DENY}" or`,
    `  "${LlmActionType.CLARIFY}". The system enforces destructive allows`,
    '  deterministically OUTSIDE of you; returning "allow" for a destructive tool',
    '  will be ignored and downgraded to a clarification.',
    '- If MORE THAN ONE attention is pending and the reply does not clearly bind',
    `  to exactly one, return "${LlmActionType.CLARIFY}" and ask which. Never guess.`,
    '- When uncertain, prefer CLARIFY or DENY. Fail closed.',
    '',
    'Allowed actions (field "type"):',
    `  ${ACTION_VALUES}`,
    `- answer: answer a pending question/plan; set targetAttentionId + text.`,
    `- approve_plan: approve a pending plan; set targetAttentionId; optional grant`,
    `  in {${GRANT_VALUES}} if the user explicitly grants standing approval.`,
    `- deny: reject a pending permission/plan; set targetAttentionId.`,
    `- allow: allow a pending NON-destructive (file-edit) permission; set`,
    `  targetAttentionId. (behavior values: ${BEHAVIOR_VALUES}.)`,
    `- steer: push the reply text into the session as guidance; set text.`,
    `- clarify: ask the user a question; set text. Use when ambiguous.`,
    '',
    'Respond with a SINGLE JSON object and nothing else:',
    '{ "type": <action>, "targetAttentionId"?: <uuid>, "text"?: <string>, "grant"?: <grant> }',
  ].join('\n');
}

function describeAttention(e: AttentionEvent): string {
  const parts = [`id=${e.id}`, `kind=${e.kind}`];
  if (e.toolName) parts.push(`tool=${e.toolName}`);
  if (e.description) parts.push(`desc=${truncate(e.description, 200)}`);
  if (e.inputPreview) parts.push(`input=${truncate(e.inputPreview, 200)}`);
  if (e.requestId) parts.push(`requestId=${e.requestId}`);
  if (e.qid) parts.push(`qid=${e.qid}`);
  return `- ${parts.join(' ')}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Build the user-turn context the LLM reasons over. */
export function userPrompt(args: {
  inbound: InboundMessage;
  pending: ReadonlyArray<AttentionEvent>;
  sessions: ReadonlyArray<SessionInfo>;
  history: ReadonlyArray<{ direction: string; body: string }>;
}): string {
  const { inbound, pending, sessions, history } = args;

  const lines: string[] = [];

  lines.push('PENDING ATTENTION (what the agent is waiting on):');
  if (pending.length === 0) {
    lines.push('  (none — there is nothing to resolve; likely a steer or chat.)');
  } else {
    for (const e of pending) lines.push(`  ${describeAttention(e)}`);
  }

  lines.push('');
  lines.push('LIVE SESSIONS:');
  if (sessions.length === 0) {
    lines.push('  (none)');
  } else {
    for (const s of sessions) {
      lines.push(
        `  - id=${s.id} state=${s.state} afk=${s.afk} grant=${s.grant}` +
          (s.cwd ? ` cwd=${truncate(s.cwd, 80)}` : ''),
      );
    }
  }

  lines.push('');
  lines.push('RECENT THREAD (most recent last):');
  const ordered = [...history].reverse();
  if (ordered.length === 0) {
    lines.push('  (no prior messages)');
  } else {
    for (const m of ordered) {
      lines.push(`  ${m.direction === 'outbound' ? 'agent' : 'user'}: ${truncate(m.body, 240)}`);
    }
  }

  lines.push('');
  lines.push('THE USER JUST SENT:');
  lines.push(`  "${inbound.text}"`);
  if (inbound.reactionTo) {
    lines.push(`  (this is a tapback/inline reply bound to message ${inbound.reactionTo})`);
  }

  lines.push('');
  lines.push('Return the JSON action now.');

  return lines.join('\n');
}

/** Assemble the full message list for llmComplete. */
export function buildMessages(args: {
  inbound: InboundMessage;
  pending: ReadonlyArray<AttentionEvent>;
  sessions: ReadonlyArray<SessionInfo>;
  history: ReadonlyArray<{ direction: string; body: string }>;
}): LlmMessage[] {
  return [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(args) },
  ];
}
