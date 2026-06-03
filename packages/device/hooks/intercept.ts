#!/usr/bin/env bun
/**
 * @imsg/device — event-aware AFK intercept (productized from the validated spike).
 *
 * Registered (see hooks/hooks.json) for only the two tools that need AFK
 * handling:
 *   - PreToolUse        with matcher AskUserQuestion|ExitPlanMode.
 *   - PermissionRequest with matcher ExitPlanMode.
 *
 * The hook does ONE job: AFK ROUTING. There is no session-grant / standing
 * auto-approval layer — every OTHER tool that needs permission is gated
 * PER-ACTION outside this hook (at the keyboard via Claude Code's native prompt;
 * while AFK via the Channels permission relay that forwards each prompt to the
 * phone). The deterministic destructive-allow gate lives server-side (control
 * plane orchestrator/safety.ts).
 *
 * At the keyboard (AFK off) the hook is a no-op — native prompts handle the two
 * tools it sees.
 *
 * While AFK (on):
 *   PreToolUse/AskUserQuestion      -> deny + "ask via message_user(expect_reply), reply_tag, STOP".
 *   PreToolUse/ExitPlanMode         -> allow. Exiting plan mode is non-destructive;
 *                                      every tool the plan then runs is gated
 *                                      per-action (it never re-enters THIS hook).
 *   PermissionRequest/ExitPlanMode  -> allow. MUST be explicit — a fall-through here
 *                                      would surface a native dialog nobody can answer.
 *
 * State file lives under the device dir (config.ts), shared with the CLI +
 * channel server. afk.state ("on"|"off").
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AfkState, AttentionKind } from '@imsg/shared';
import { logDir, migrateLegacyDeviceDir, pickEagerSessionId } from '../src/config.ts';
import { readAfk } from '../src/state.ts';
import { postState } from './state-ping.ts';

// Relocate pre-0.1.7 state (incl. afk.state) into ~/.imsg before any read below.
migrateLegacyDeviceDir();
mkdirSync(logDir(), { recursive: true });
const HOOK_LOG = join(logDir(), 'pretooluse.log');

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
log({ event: 'hook_fired', hook_event: evt, tool_name: tool, afk: afk ? 'on' : 'off' });

// AFK OFF + a native question/plan prompt is about to open → mark the session
// WAITING for the dashboard (state-only — not a surfaced attention). The
// PostToolUse state hook flips it back to ACTIVE once the prompt is answered.
if (!afk && evt === PRE_TOOL_USE && (tool === ASK_USER_QUESTION || tool === EXIT_PLAN_MODE)) {
  await postState(AttentionKind.BLOCKED, sessionId);
}

// At the keyboard -> native prompts handle everything (no-op for every event).
if (!afk) process.exit(0);

// AFK routing. ExitPlanMode is allowed to proceed (non-destructive); the plan's
// actual tools are each gated per-action when they re-enter this hook.
if (evt === PRE_TOOL_USE) {
  if (tool === ASK_USER_QUESTION) emitPre('deny', ASK_REASON);
  if (tool === EXIT_PLAN_MODE) {
    log({ event: 'exitplanmode_pre_allowed' });
    emitPre('allow', 'AFK: exiting plan mode; downstream tools are gated per-action.');
  }
  process.exit(0);
}

if (evt === PERMISSION_REQUEST) {
  if (tool === EXIT_PLAN_MODE) {
    log({ event: 'exitplanmode_perm_allowed' });
    emitPerm('allow');
  }
  process.exit(0);
}

process.exit(0);
