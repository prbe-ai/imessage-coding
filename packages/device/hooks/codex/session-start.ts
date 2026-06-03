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
 *  2. Spawn the per-session TAP daemon (detached) with IMSG_AGENT_KIND=codex so
 *     bin/tap.ts takes the Codex branch. Only when paired + not killswitched,
 *     and not already running (resume-safe).
 *
 * Differences from the CC hook, all forced by Codex's contract:
 *   - Codex sets transcript_path NULLABLE on SessionStart — the rollout file may
 *     not exist yet when the hook fires. When transcript_path is empty we cannot
 *     write the handshake (it needs the path) or tail a rollout, so we carry on
 *     and skip the daemon this fire; a later resume fire (or the MCP server's own
 *     id resolution) recovers the id. We never spawn a tap without a real rollout
 *     path — the byte-offset tailer needs a concrete file.
 *   - Codex has NO SessionEnd hook, so there is no teardown counterpart. The tap
 *     daemon self-exits via its own lsof orphan check once Codex closes the
 *     rollout (see bin/tap.ts).
 *   - Codex hooks signal "carry on" with stdout {"continue": true}.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentKind } from '@imsg/shared';
import {
  migrateLegacyDeviceDir,
  pluginRoot,
  sessionPidFile,
  sessionShutdownFile,
  sessionsDir,
} from '../../src/config.ts';
import { loadToken } from '../../src/creds.ts';
import { localDisabled } from '../../src/killswitch.ts';
import { writeHandshake } from '../../src/handshake.ts';

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
// record, so carry on — a resume fire (or the MCP server) recovers the id.
if (!sessionId || !transcriptPath) carryOn();

// 1) Handshake for the MCP server's session-id resolution.
try {
  writeHandshake({ sessionId, transcriptPath, cwd: projectDir, at: new Date().toISOString() });
} catch {
  /* best-effort */
}

// 2) Daemon: paired + not killswitched only.
const token = loadToken();
if (!token || localDisabled()) carryOn();

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
      carryOn(); // alive → leave it running
    }
  } catch {
    /* not alive → fall through and respawn */
  }
}

const tapPath = join(pluginRoot(), 'bin', 'tap.ts');
const child = spawn(
  process.execPath, // the bun binary running this hook
  [tapPath, '--session-id', sessionId, '--transcript', transcriptPath, '--cwd', projectDir],
  {
    detached: true,
    stdio: 'ignore',
    cwd: pluginRoot(),
    // The tap branches on agentKind() → IMSG_AGENT_KIND. Inherit + force codex so
    // the daemon uses the Codex rollout reducer (extractCodexActivity).
    env: { ...process.env, IMSG_AGENT_KIND: AgentKind.CODEX },
  },
);
child.unref();
try {
  writeFileSync(pidFile, String(child.pid ?? ''), 'utf8');
} catch {
  /* ignore */
}
carryOn();
