#!/usr/bin/env bun
/**
 * @imsg/device — Codex Stop hook: the AFK turn gate.
 *
 * The Codex counterpart to the Stop branch of hooks/state-hook.ts. While AFK,
 * don't let a turn END until the agent has actually reached the user via the
 * message_user MCP tool. If it never did this turn, BLOCK the stop once with an
 * instruction to report — Codex re-injects `reason` as a new user prompt and
 * continues. The decision is the symmetric counterpart to intercept.ts denying
 * AskUserQuestion, ported to Codex's blocking Stop hook.
 *
 * Codex's Stop hook can BLOCK+reprompt via stdout {"decision":"block","reason":…}
 * and has NO system loop cap (unlike Claude Code's 8-block ceiling), so we MUST
 * self-limit: release if stop_hook_active is true (we already nudged once) OR the
 * agent already called message_user this turn. The pure decision lives in
 * shouldBlockStop() (src/codex-hooks.ts) and is unit-tested.
 *
 * Detecting "did the agent report this turn?": message_user is an MCP tool CALL,
 * recorded in the Codex rollout as a response_item.function_call — not in
 * last_assistant_message (which is the final assistant TEXT). So we scan the
 * rollout via codexMessagedUserThisTurn(transcript_path). last_assistant_message
 * is not a reliable signal for a tool call and is intentionally not used here.
 *
 * State pings: unlike the CC Stop hook this does NOT post a TURN_COMPLETE ping —
 * the Codex session's lifecycle state is driven by the tap daemon + heartbeat,
 * and Codex has no PostToolUse-for-questions counterpart. Keeping the Stop hook a
 * pure AFK gate avoids a second source of truth for session state.
 */
import { writeSync } from 'node:fs';
import { AfkState, AgentKind } from '@imsg/shared';
import { isPluginHousekeepingDir, migrateLegacyDeviceDir } from '../../src/config.ts';
import { readAfk } from '../../src/state.ts';
import { ensureTap } from '../../src/tap-spawn.ts';
import { codexMessagedUserThisTurn, shouldBlockStop } from '../../src/codex-hooks.ts';

// Relocate pre-0.1.7 state into ~/.imsg before reading afk.state.
migrateLegacyDeviceDir();

// Neutral instruction wording, reused verbatim from state-hook.ts's
// AFK_REPORT_REASON — the symmetric counterpart to intercept.ts's ASK_REASON.
const AFK_REPORT_REASON =
  'You are AFK: the user is remote and cannot see this terminal, and you have not called `message_user` this turn. ' +
  'Do not end the turn silently. Call the `message_user` tool now with a concise summary of what you did / your ' +
  'result (leave expect_reply false unless you actually need an answer), then stop.';

const raw = await Bun.stdin.text();
let input: Record<string, unknown> = {};
try {
  input = JSON.parse(raw) as Record<string, unknown>;
} catch {
  /* malformed hook input — treat as empty, fall through to allow */
}

const afk = readAfk() === AfkState.ON;
const stopHookActive = input['stop_hook_active'] === true;
const transcriptPath =
  typeof input['transcript_path'] === 'string' ? input['transcript_path'] : '';
const messagedThisTurn = transcriptPath ? codexMessagedUserThisTurn(transcriptPath) : false;

// Keep the tap alive on turn-end too (respawn a crashed tap; cover a session whose
// rollout only appeared after SessionStart). Idempotent once the tap is healthy.
const sessionId = typeof input['session_id'] === 'string' ? input['session_id'] : '';
const cwd =
  (process.env.CLAUDE_PROJECT_DIR && process.env.CLAUDE_PROJECT_DIR.trim()) ||
  (typeof input['cwd'] === 'string' ? input['cwd'] : '') ||
  process.cwd();
if (sessionId && transcriptPath && !isPluginHousekeepingDir(cwd)) {
  ensureTap({ sessionId, transcriptPath, cwd, agentKind: AgentKind.CODEX });
}

if (shouldBlockStop({ afk, stopHookActive, messagedThisTurn })) {
  // writeSync (not process.stdout.write) so the decision is flushed to fd 1
  // before exit — a dropped block would silently un-gate the AFK turn.
  writeSync(1, JSON.stringify({ decision: 'block', reason: AFK_REPORT_REASON }));
  process.exit(0);
}

// Either the agent reported, or we already nudged once (stop_hook_active), or
// AFK is off — allow the turn to end.
process.exit(0);
