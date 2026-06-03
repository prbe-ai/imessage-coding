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
 *  2. Spawn the per-session TAP daemon (detached) to stream AFK activity. Only
 *     when paired + not locally killswitched, and not already running (resume).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  migrateLegacyDeviceDir,
  pluginRoot,
  sessionPidFile,
  sessionShutdownFile,
  sessionsDir,
} from '../src/config.ts';
import { loadToken } from '../src/creds.ts';
import { localDisabled } from '../src/killswitch.ts';
import { writeHandshake } from '../src/handshake.ts';

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

// 2) Daemon: paired + not killswitched only.
const token = loadToken();
if (!token || localDisabled()) process.exit(0);

mkdirSync(sessionsDir(), { recursive: true });
// Clear any stale shutdown sentinel from a prior run of this id (e.g. a resume).
try {
  rmSync(sessionShutdownFile(sessionId), { force: true });
} catch {
  /* ignore */
}

// Idempotent: if a daemon for this session is already alive, don't spawn another.
const pidFile = sessionPidFile(sessionId);
if (existsSync(pidFile)) {
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isFinite(pid)) {
      process.kill(pid, 0); // throws if not alive
      process.exit(0); // alive → leave it running
    }
  } catch {
    /* not alive → fall through and respawn */
  }
}

const tapPath = join(pluginRoot(), 'bin', 'tap.ts');
const child = spawn(
  process.execPath, // the bun binary running this hook
  [tapPath, '--session-id', sessionId, '--transcript', transcriptPath, '--cwd', projectDir],
  { detached: true, stdio: 'ignore', cwd: pluginRoot() },
);
child.unref();
try {
  writeFileSync(pidFile, String(child.pid ?? ''), 'utf8');
} catch {
  /* ignore */
}
process.exit(0);
