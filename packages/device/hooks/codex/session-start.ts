#!/usr/bin/env bun
/**
 * @imsg/device — Codex SessionStart hook.
 *
 * The Codex counterpart to hooks/session-start.ts. Same two jobs, from the
 * {session_id, transcript_path, cwd} Codex hands us on stdin (matcher
 * startup|resume|clear):
 *
 *  1. Write a project-dir-keyed HANDSHAKE so the long-lived MCP server can learn
 *     its real session id (the MCP server gets no session-scoped env). Always
 *     done (cheap) — only when transcript_path is present (see below).
 *  2. Ensure the per-session TAP daemon is running (ensureTap, with agentKind=codex
 *     so bin/tap.ts takes the Codex rollout reducer). Only when paired + not
 *     killswitched (ensureTap's own guards), and never for Codex's OWN plugin
 *     housekeeping sessions.
 *
 * Differences from the CC hook, all forced by Codex's contract:
 *   - Codex sets transcript_path NULLABLE on SessionStart — the rollout file may
 *     not exist yet when the hook fires. When transcript_path is empty we cannot
 *     write the handshake (it needs the path) or tail a rollout, so we carry on and
 *     skip the daemon this fire. The FIRST UserPromptSubmit (rollout now written)
 *     calls ensureTap and finally spawns the tap — that per-turn retry is what
 *     fixes Codex sessions previously capturing zero history.
 *   - Codex has NO SessionEnd hook, so there is no teardown counterpart. The tap
 *     daemon self-exits via its own lsof orphan check once Codex closes the
 *     rollout (see bin/tap.ts).
 *   - Codex hooks signal "carry on" with stdout {"continue": true}.
 */
import { AgentKind } from '@imsg/shared';
import { isPluginHousekeepingDir, migrateLegacyDeviceDir } from '../../src/config.ts';
import { writeHandshake } from '../../src/handshake.ts';
import { ensureTap } from '../../src/tap-spawn.ts';

/** Codex hooks signal "continue" via stdout. Emit + exit 0 from one place. */
function carryOn(): never {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

// Relocate pre-0.1.7 state into ~/.imsg before the handshake / tap touch it.
migrateLegacyDeviceDir();

const raw = await Bun.stdin.text();
let input: Record<string, unknown> = {};
try {
  input = JSON.parse(raw) as Record<string, unknown>;
} catch {
  /* malformed hook input — nothing we can do */
}
const sessionId = String(input['session_id'] ?? '');
const transcriptPath = String(input['transcript_path'] ?? '');
const cwdIn = String(input['cwd'] ?? '');
// Key by the SAME value the MCP server reads. Codex sets CLAUDE_PLUGIN_ROOT for
// hooks but the MCP server reads CLAUDE_PROJECT_DIR; fall back to the hook's cwd.
const projectDir =
  (process.env.CLAUDE_PROJECT_DIR && process.env.CLAUDE_PROJECT_DIR.trim()) || cwdIn || process.cwd();

// session_id is required; transcript_path may be null/empty on a Codex
// SessionStart (the rollout isn't written yet). Without a concrete rollout path
// the byte-offset tap has nothing to tail and the handshake has no path to
// record, so carry on — the first UserPromptSubmit recovers it.
if (!sessionId || !transcriptPath) carryOn();

// 1) Handshake for the MCP server's session-id resolution — written UNconditionally
// (as before), so the housekeeping gate below scopes only the tap, not id resolution.
try {
  writeHandshake({ sessionId, transcriptPath, cwd: projectDir, at: new Date().toISOString() });
} catch {
  /* best-effort */
}

// 2) Never tap Codex's OWN plugin housekeeping sessions (install / marketplace
// validation, rooted under ~/.codex/{plugins,marketplaces}/…). Those carry no user
// prompt, so tapping them just registers titleless dashboard rows.
if (isPluginHousekeepingDir(projectDir) || isPluginHousekeepingDir(cwdIn)) carryOn();

// 3) Spawn (or confirm) the tap daemon on the Codex branch.
ensureTap({ sessionId, transcriptPath, cwd: projectDir, agentKind: AgentKind.CODEX });
carryOn();
