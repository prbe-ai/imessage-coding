#!/usr/bin/env bun
/**
 * @imsg/device — event-aware AFK intercept (productized from the validated spike).
 *
 * Registered (see hooks/hooks.json) for:
 *   - PreToolUse with matcher "*"          — fires for EVERY tool call.
 *   - PermissionRequest with matcher       — ExitPlanMode only.
 *
 * The PreToolUse matcher is "*" so the session-grant layer below can act on ANY
 * tool (a narrow matcher would make the grant feature dead code). This is SAFE
 * because the control plane caps any LLM-originated grant at GrantLevel.EDITS
 * (orchestrator validateAction), and GrantLevel.EDITS auto-allows ONLY file-edit
 * tools here — Bash/everything else still falls through to the normal prompt.
 * GrantLevel.FULL (auto-allow everything) is reachable ONLY via the authenticated
 * dashboard, never by LLM inference.
 *
 * Always logs that it fired, then applies the SAME two-layer logic the spike
 * validated:
 *
 *  1) SESSION GRANT (the "allow all edits this session" / shift-tab equivalent,
 *     applied regardless of AFK because it's a session permission level):
 *       grant=full  -> auto-allow EVERY tool (true bypass; dashboard-only).
 *       grant=edits -> auto-allow ONLY file-edit tools
 *                      (Edit/Write/MultiEdit/NotebookEdit). Bash and every other
 *                      tool fall through to the normal AFK routing / native
 *                      prompt — NEVER auto-allowed (fail-CLOSED invariant).
 *       grant=off   -> no session grant.
 *     Implemented via PreToolUse permissionDecision:"allow" because a hook cannot
 *     reliably set CC's native permission mode. INVARIANT: a non-edit tool is
 *     never auto-allowed except under grant=full.
 *
 *  2) AFK ROUTING (only the question/plan tools, only when AFK on):
 *       PreToolUse/AskUserQuestion -> deny + "ask via message_user(expect_reply), reply_tag, STOP".
 *       PreToolUse/ExitPlanMode    -> no grant: deny+hold; grant present: allow.
 *       PermissionRequest/ExitPlanMode -> grant present: behavior:allow.
 *
 * CHANGE FROM THE SPIKE: plan approval no longer reads a local plan-approval.json
 * written by a localhost server. The cloud control plane is the authority: when
 * the user approves a plan from their phone, the channel server's decision
 * long-poll writes the resulting GrantLevel (edits/full) to grant.state. So an
 * ExitPlanMode re-call is permitted exactly when a session grant is present —
 * that grant IS the remote approval signal. With no grant, ExitPlanMode stays
 * held (fail-CLOSED): the agent must relay + wait, never proceed by inference.
 *
 * State files live under the device dir (config.ts), shared with the CLI +
 * channel server. afk.state ("on"|"off"), grant.state ("off"|"edits"|"full").
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AfkState, AttentionKind, GrantLevel } from '@imsg/shared';
import { logDir, pickEagerSessionId } from '../src/config.ts';
import { readAfk, readGrant } from '../src/state.ts';
import { postState } from './state-ping.ts';

mkdirSync(logDir(), { recursive: true });
const HOOK_LOG = join(logDir(), 'pretooluse.log');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const ASK_USER_QUESTION = 'AskUserQuestion';
const EXIT_PLAN_MODE = 'ExitPlanMode';
const PRE_TOOL_USE = 'PreToolUse';
const PERMISSION_REQUEST = 'PermissionRequest';

function log(d: Record<string, unknown>): void {
  try {
    appendFileSync(HOOK_LOG, JSON.stringify({ ts: new Date().toISOString(), ...d }) + '\n');
  } catch {
    /* best-effort */
  }
}

function emitPre(decision: 'allow' | 'deny' | 'ask', reason: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: PRE_TOOL_USE,
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function emitPerm(behavior: 'allow' | 'deny'): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: PERMISSION_REQUEST, decision: { behavior } },
    }),
  );
  process.exit(0);
}

// Neutral instruction wording, carried over from the spike verbatim (only the
// channel source name differs, set by the channel server).
const ASK_REASON =
  'The user is AFK (away). Do NOT answer this yourself and do NOT retry AskUserQuestion. Call the `message_user` tool now ' +
  'with expect_reply: true, the exact question and ALL options, and a unique reply_tag. Then STOP and end your turn. The user ' +
  'will reply via a <channel source="imsg-device"> message; resume using that answer.';
const PLAN_REASON =
  'The user is AFK and cannot see the native plan prompt. Do NOT proceed and do NOT retry ExitPlanMode yet. Send a ' +
  'concise summary of THIS plan to the user via the `message_user` tool with expect_reply: true and a reply_tag, asking them to ' +
  'approve or reject. Then STOP and end your turn. When approval arrives as a <channel> message, re-call ExitPlanMode once — it will be allowed.';

const raw = await Bun.stdin.text();
let input: Record<string, unknown> = {};
try {
  input = JSON.parse(raw) as Record<string, unknown>;
} catch {
  /* malformed hook input — treat as empty, fall through to no-op */
}
const evt = String(input['hook_event_name'] ?? input['hookEventName'] ?? '');
const tool = String(input['tool_name'] ?? input['toolName'] ?? '');
const sessionId =
  (typeof input['session_id'] === 'string' && input['session_id']) || pickEagerSessionId() || '';
const afk = readAfk() === AfkState.ON;
const grant = readGrant(); // GrantLevel: off | edits | full
log({ event: 'hook_fired', hook_event: evt, tool_name: tool, afk: afk ? 'on' : 'off', grant });

// 1) SESSION GRANT — applies regardless of AFK, for normal tools (not the
//    special question/plan tools, which have their own handling below). The
//    PreToolUse matcher is "*", so this layer is reached for EVERY tool.
//    INVARIANT (fail-CLOSED): a non-edit tool is auto-allowed ONLY under
//    grant=full (dashboard-only). Under grant=edits, only file-edit tools are
//    auto-allowed; Bash / everything else fall through to AFK routing / the
//    native prompt and are NEVER auto-allowed here.
if (evt === PRE_TOOL_USE && tool !== ASK_USER_QUESTION && tool !== EXIT_PLAN_MODE) {
  if (grant === GrantLevel.FULL) {
    log({ event: 'grant_allow', grant, tool });
    emitPre('allow', 'Session grant: full — auto-approved.');
  }
  if (grant === GrantLevel.EDITS && EDIT_TOOLS.has(tool)) {
    log({ event: 'grant_allow', grant, tool });
    emitPre('allow', 'Session grant: allow-all-edits — auto-approved file edit.');
  }
  // grant=off, OR grant=edits with a non-edit tool: fall through (no auto-allow).
}

// AFK OFF + a native question/plan prompt is about to open → mark the session
// WAITING for the dashboard (state-only — not a surfaced attention). The
// PostToolUse state hook flips it back to ACTIVE once the prompt is answered.
if (!afk && evt === PRE_TOOL_USE && (tool === ASK_USER_QUESTION || tool === EXIT_PLAN_MODE)) {
  await postState(AttentionKind.BLOCKED, sessionId);
}

// 2) AFK routing for question/plan tools. At the keyboard (AFK off) -> native.
if (!afk) process.exit(0);

// A session grant is the cloud-side "plan approved" signal: with edits/full
// present, ExitPlanMode is allowed; otherwise it stays held (fail-CLOSED).
const planApproved = grant === GrantLevel.EDITS || grant === GrantLevel.FULL;

if (evt === PRE_TOOL_USE) {
  if (tool === ASK_USER_QUESTION) emitPre('deny', ASK_REASON);
  if (tool === EXIT_PLAN_MODE) {
    if (planApproved) {
      log({ event: 'exitplanmode_pre_allowed', grant });
      emitPre('allow', 'Plan approved remotely; confirming.');
    }
    emitPre('deny', PLAN_REASON);
  }
  process.exit(0);
}

if (evt === PERMISSION_REQUEST) {
  if (tool === EXIT_PLAN_MODE) {
    if (planApproved) {
      log({ event: 'exitplanmode_perm_allowed', grant });
      emitPerm('allow');
    }
    log({ event: 'exitplanmode_perm_no_approval' });
    process.exit(0);
  }
  process.exit(0);
}

process.exit(0);
