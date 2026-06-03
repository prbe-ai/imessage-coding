#!/usr/bin/env bun
/**
 * @imsg/device — Codex UserPromptSubmit hook: AFK awareness injection.
 *
 * The Codex counterpart to the UserPromptSubmit branch of hooks/state-hook.ts
 * (Fix B — proactive awareness). While AFK, inject a reminder at the START of
 * every turn that the user is remote and the agent must reach them via
 * message_user — so the model knows from the outset, not only once it hits a
 * question/permission gate.
 *
 * Codex's UserPromptSubmit can inject context via stdout
 * {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":…}}.
 * AFK off → no-op (exit 0); the reminder would be noise at the keyboard.
 *
 * NOTE: unlike the CC state-hook this does NOT post a TURN_START state ping —
 * Codex session state is driven by the tap daemon + heartbeat, and we keep this
 * hook a single-purpose AFK nudge (no second source of truth for session state).
 */
import { writeSync } from 'node:fs';
import { AfkState } from '@imsg/shared';
import { migrateLegacyDeviceDir } from '../../src/config.ts';
import { readAfk } from '../../src/state.ts';

const USER_PROMPT_SUBMIT = 'UserPromptSubmit';

// Reused verbatim from state-hook.ts's AFK_TURN_CONTEXT (Fix B) — adapted only in
// that AskUserQuestion/ExitPlanMode are Claude-Code concepts; on Codex the same
// rule holds: ask via message_user(expect_reply) and stop, since the Stop gate
// blocks a silent turn-end and a destructive action is relayed for approval.
const AFK_TURN_CONTEXT =
  'AFK mode is ON: the user is driving you remotely over iMessage and cannot see this terminal. Before you end this ' +
  'turn, call the `message_user` tool with a short summary of what you did / your result (expect_reply: false) — that ' +
  'is the only way the user learns the turn finished, and the turn will be blocked from ending until you do. To ask ' +
  'the user anything, call `message_user` with expect_reply: true and then stop; their reply arrives as a ' +
  '<channel source="imsg-device"> message you should treat as authoritative.';

// Relocate pre-0.1.7 state into ~/.imsg before reading afk.state.
migrateLegacyDeviceDir();

// We don't need stdin contents, but drain it so the hook doesn't block on a
// writer holding the pipe open (Codex passes the prompt JSON on stdin).
await Bun.stdin.text().catch(() => '');

if (readAfk() === AfkState.ON) {
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
