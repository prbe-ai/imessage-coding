#!/usr/bin/env bun
/**
 * @imsg/device — lifecycle → session-state reporter.
 *
 * Registered (see hooks.json) for:
 *   - UserPromptSubmit  — a turn started → ACTIVE.
 *   - Stop              — the turn finished → IDLE (the server keeps it WAITING
 *                         instead if an attention is still unresolved, e.g. an
 *                         AFK `message_user(expect_reply)` parked on a phone reply).
 *   - PostToolUse / AskUserQuestion|ExitPlanMode — a native question/plan was just
 *                         answered → ACTIVE (clears the WAITING the PreToolUse
 *                         intercept set when the prompt opened).
 *
 * Fires a best-effort direct POST and exits. See state-ping.ts for the egress
 * rationale (state pings direct-post; only the activity transcript is batched).
 */
import { AttentionKind } from '@imsg/shared';
import { pickEagerSessionId } from '../src/config.ts';
import { postState } from './state-ping.ts';

const USER_PROMPT_SUBMIT = 'UserPromptSubmit';
const STOP = 'Stop';
const POST_TOOL_USE = 'PostToolUse';

const raw = await Bun.stdin.text();
let input: Record<string, unknown> = {};
try {
  input = JSON.parse(raw) as Record<string, unknown>;
} catch {
  /* malformed hook input — treat as empty, no-op below */
}

const evt = String(input['hook_event_name'] ?? input['hookEventName'] ?? '');
const sessionId =
  (typeof input['session_id'] === 'string' && input['session_id']) || pickEagerSessionId() || '';

// Map the lifecycle event to a session-state kind. PostToolUse is registered only
// for AskUserQuestion|ExitPlanMode, so its completion means a question/plan was
// answered → back to working.
//
// Deliberately ONLY `Stop` (the main agent finishing), never `SubagentStop`: a
// Task subagent completing must NOT flip the parent session to idle while the
// main turn is still running. Do not add SubagentStop → TURN_COMPLETE here.
let kind: AttentionKind | null = null;
if (evt === USER_PROMPT_SUBMIT) kind = AttentionKind.TURN_START;
else if (evt === STOP) kind = AttentionKind.TURN_COMPLETE;
else if (evt === POST_TOOL_USE) kind = AttentionKind.TURN_START;

if (kind) await postState(kind, sessionId);
process.exit(0);
