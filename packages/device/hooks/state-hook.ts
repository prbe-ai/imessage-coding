#!/usr/bin/env bun
/**
 * @imsg/device — lifecycle → session-state reporter + AFK turn gate.
 *
 * Registered (see hooks.json) for:
 *   - UserPromptSubmit  — a turn started → ACTIVE. While AFK, ALSO injects a
 *                         reminder that the user is remote, so the model knows
 *                         from the START of the turn (not only once it hits a
 *                         question/permission gate). [Fix B — proactive awareness]
 *   - Stop              — the turn finished → IDLE (the server keeps it WAITING
 *                         instead if an attention is still unresolved, e.g. an
 *                         AFK `message_user(expect_reply)` parked on a phone reply).
 *                         While AFK, GATES turn-end: if the agent never called
 *                         message_user this turn, the stop is blocked once with an
 *                         instruction to report first — the symmetric counterpart
 *                         to intercept.ts denying AskUserQuestion. [Fix A]
 *   - PostToolUse / AskUserQuestion|ExitPlanMode — a native question/plan was just
 *                         answered → ACTIVE (clears the WAITING the PreToolUse
 *                         intercept set when the prompt opened).
 *
 * Fires a best-effort direct POST and exits. See state-ping.ts for the egress
 * rationale (state pings direct-post; only the activity transcript is batched).
 */
import { writeSync } from 'node:fs';
import { AfkState, AttentionKind } from '@imsg/shared';
import { migrateLegacyDeviceDir, pickEagerSessionId } from '../src/config.ts';
import { readAfk } from '../src/state.ts';
import { ensureTap } from '../src/tap-spawn.ts';
import { messagedUserThisTurn } from '../src/transcript.ts';
import { postState } from './state-ping.ts';

// Relocate pre-0.1.7 state into ~/.imsg (UserPromptSubmit fires early in a session).
migrateLegacyDeviceDir();

const USER_PROMPT_SUBMIT = 'UserPromptSubmit';
const STOP = 'Stop';
const POST_TOOL_USE = 'PostToolUse';

// Fix B — injected into the model's context at every turn start while AFK, so it
// is aware it's remote-driven from the outset (not only once a gate denies it).
const AFK_TURN_CONTEXT =
  'AFK mode is ON: the user is driving you remotely over iMessage and cannot see this terminal. Before you end this ' +
  'turn, call the `message_user` tool with a short summary of what you did / your result (expect_reply: false) — that ' +
  'is the only way the user learns the turn finished. To ask the user anything, call `message_user` with ' +
  'expect_reply: true and then stop; AskUserQuestion and ExitPlanMode are intercepted while AFK.';

// Fix A — Stop-block reason when the turn is about to end AFK without any report.
const AFK_REPORT_REASON =
  'You are AFK: the user is remote and cannot see this terminal, and you have not called `message_user` this turn. ' +
  'Do not end the turn silently. Call the `message_user` tool now with a concise summary of what you did / your ' +
  'result (leave expect_reply false unless you actually need an answer), then stop.';

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
const afk = readAfk() === AfkState.ON;
const transcriptPath =
  typeof input['transcript_path'] === 'string' ? input['transcript_path'] : '';
const cwd =
  (process.env.CLAUDE_PROJECT_DIR && process.env.CLAUDE_PROJECT_DIR.trim()) ||
  (typeof input['cwd'] === 'string' ? input['cwd'] : '') ||
  process.cwd();

// Keep the tap alive on every turn boundary (UserPromptSubmit + Stop): respawn for
// a session that was open before a plugin update, or whose detached tap crashed.
// Cheap (a single stat) when the tap is already healthy, and placed BEFORE the AFK
// Stop-gate below so a blocked-stop turn still re-ensures the tap.
if (sessionId && transcriptPath) ensureTap({ sessionId, transcriptPath, cwd });

// Fix A — AFK Stop gate. While AFK, don't let the turn END until the agent has
// actually reached the user. If it never called message_user this turn, block the
// stop ONCE (stop_hook_active guards against a loop; CC also force-ends after 8
// consecutive blocks) with an instruction to report. The turn is NOT complete in
// that case, so we deliberately skip the TURN_COMPLETE ping below — the session is
// still working (composing the report).
if (evt === STOP && afk) {
  const stopHookActive = input['stop_hook_active'] === true;
  const messaged = transcriptPath ? messagedUserThisTurn(transcriptPath) : false;
  if (!messaged && !stopHookActive) {
    // writeSync (not process.stdout.write) so the decision is flushed to fd 1
    // before process.exit — a dropped block would silently un-gate the AFK turn.
    writeSync(1, JSON.stringify({ decision: 'block', reason: AFK_REPORT_REASON }));
    process.exit(0);
  }
  // Either the agent reported (message_user seen this turn), or we already nudged
  // once (stop_hook_active) and won't fight Claude Code's 8-block cap — allow the
  // stop and report TURN_COMPLETE below. Note: the give-up branch does end the
  // turn without a report; one forced nudge is the bounded trade-off.
}

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

// Fix B — at turn start while AFK, inject the remote-driven reminder so the model
// is aware for the whole turn.
if (evt === USER_PROMPT_SUBMIT && afk) {
  writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: USER_PROMPT_SUBMIT,
        additionalContext: AFK_TURN_CONTEXT,
      },
    }),
  );
}
process.exit(0);
