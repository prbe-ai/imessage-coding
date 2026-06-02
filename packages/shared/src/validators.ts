/**
 * @imsg/shared — hand-rolled, dependency-light validators / guards.
 *
 * Kept tiny on purpose: no zod, no runtime deps. These are used at trust
 * boundaries (webhook parse, device API request bodies) to narrow `unknown`.
 */
import {
  ActivityKind,
  AfkState,
  AgentKind,
  AttentionKind,
  DecisionBehavior,
  DecisionSource,
  GrantLevel,
  MessageChannel,
  SessionState,
} from './enums.ts';
import type {
  ActivityBatchBody,
  ActivityEvent,
  AttentionEvent,
  Decision,
  InboundMessage,
  OutboundMessage,
} from './types.ts';

/** True if `v` is one of the values of a const-object enum map. */
export function isEnumValue<T extends Record<string, string>>(
  e: T,
  v: unknown,
): v is T[keyof T] {
  return typeof v === 'string' && (Object.values(e) as string[]).includes(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isOptString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === 'string';
}

function isOptRecord(v: unknown): v is Record<string, unknown> | undefined {
  return v === undefined || (isRecord(v) && !Array.isArray(v));
}

function isOptArray(v: unknown): v is unknown[] | undefined {
  return v === undefined || Array.isArray(v);
}

// --- specific enum guards ----------------------------------------------------

export const isAfkState = (v: unknown): v is AfkState => isEnumValue(AfkState, v);
export const isGrantLevel = (v: unknown): v is GrantLevel =>
  isEnumValue(GrantLevel, v);
export const isAttentionKind = (v: unknown): v is AttentionKind =>
  isEnumValue(AttentionKind, v);
export const isActivityKind = (v: unknown): v is ActivityKind =>
  isEnumValue(ActivityKind, v);
export const isDecisionBehavior = (v: unknown): v is DecisionBehavior =>
  isEnumValue(DecisionBehavior, v);
export const isDecisionSource = (v: unknown): v is DecisionSource =>
  isEnumValue(DecisionSource, v);
export const isSessionState = (v: unknown): v is SessionState =>
  isEnumValue(SessionState, v);
export const isAgentKind = (v: unknown): v is AgentKind =>
  isEnumValue(AgentKind, v);
export const isMessageChannel = (v: unknown): v is MessageChannel =>
  isEnumValue(MessageChannel, v);

// --- primitive guards --------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True if `v` is a canonical UUID string. Used to filter ids before a
 *  Postgres `::uuid[]` cast (a malformed id would otherwise 22P02 the query). */
export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && UUID_RE.test(v);

// --- shape guards ------------------------------------------------------------

export function isAttentionEvent(v: unknown): v is AttentionEvent {
  if (!isRecord(v)) return false;
  return (
    isString(v['id']) &&
    isString(v['deviceId']) &&
    isString(v['sessionId']) &&
    isAttentionKind(v['kind']) &&
    isOptString(v['toolName']) &&
    isOptString(v['description']) &&
    isOptString(v['inputPreview']) &&
    isOptString(v['requestId']) &&
    isOptString(v['qid']) &&
    isOptString(v['notifyMessageId']) &&
    isString(v['createdAt'])
  );
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

export function isActivityEvent(v: unknown): v is ActivityEvent {
  if (!isRecord(v)) return false;
  return (
    isNonNegInt(v['lineNo']) &&
    isNonNegInt(v['blockIdx']) &&
    isActivityKind(v['kind']) &&
    isOptString(v['toolName']) &&
    isOptString(v['text']) &&
    isOptString(v['summary']) &&
    (v['isError'] === undefined || typeof v['isError'] === 'boolean') &&
    isString(v['at'])
  );
}

export function isActivityBatchBody(v: unknown): v is ActivityBatchBody {
  if (!isRecord(v)) return false;
  if (!isString(v['sessionId'])) return false;
  if (!isOptString(v['cwd'])) return false;
  const events = v['events'];
  return Array.isArray(events) && events.every(isActivityEvent);
}

export function isDecision(v: unknown): v is Decision {
  if (!isRecord(v)) return false;
  if (!isString(v['attentionId'])) return false;
  if (v['behavior'] !== undefined && !isDecisionBehavior(v['behavior'])) {
    return false;
  }
  if (!isOptString(v['answerText'])) return false;
  if (v['grant'] !== undefined && !isGrantLevel(v['grant'])) return false;
  if (!isString(v['resolvedAt'])) return false;
  return isDecisionSource(v['source']);
}

export function isInboundMessage(v: unknown): v is InboundMessage {
  if (!isRecord(v)) return false;
  return (
    isString(v['from']) &&
    isString(v['text']) &&
    isMessageChannel(v['channel']) &&
    isOptString(v['conversationId']) &&
    isOptRecord(v['conversationState']) &&
    isOptArray(v['recentHistory']) &&
    isOptString(v['reactionTo']) &&
    isString(v['messageId'])
  );
}

export function isOutboundMessage(v: unknown): v is OutboundMessage {
  if (!isRecord(v)) return false;
  return (
    isString(v['to']) &&
    isString(v['text']) &&
    isOptString(v['replyToMessageId'])
  );
}
