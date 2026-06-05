#!/usr/bin/env bun
/**
 * @imsg/device — SessionStart hook.
 *
 * Two jobs, both from the {session_id, transcript_path, cwd} CC hands us on stdin
 * (the ONLY place the real session id + transcript path are available — the MCP
 * server never gets them):
 *
 *  1. Write a project-dir-keyed HANDSHAKE so the long-lived MCP server can learn
 *     its real session id (fixes the random-UUID bug). Always done (cheap).
 *  2. Ensure the per-session TAP daemon is running (ensureTap handles the paired +
 *     not-killswitched + idempotency/liveness guards). The same ensureTap also runs
 *     from the per-turn hooks, so a session already open before a plugin update —
 *     or a tap that crashed — is recovered there too.
 */
import { migrateLegacyDeviceDir } from '../src/config.ts';
import { writeHandshake } from '../src/handshake.ts';
import { ensureTap } from '../src/tap-spawn.ts';

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
// Key by the SAME value the MCP server reads (CLAUDE_PROJECT_DIR), so they match.
const projectDir =
  (process.env.CLAUDE_PROJECT_DIR && process.env.CLAUDE_PROJECT_DIR.trim()) || cwdIn || process.cwd();

if (!sessionId || !transcriptPath) process.exit(0);

// 1) Handshake for the MCP server's session-id resolution.
try {
  writeHandshake({ sessionId, transcriptPath, cwd: projectDir, at: new Date().toISOString() });
} catch {
  /* best-effort */
}

// 2) Spawn (or confirm) the tap daemon.
ensureTap({ sessionId, transcriptPath, cwd: projectDir });
process.exit(0);
