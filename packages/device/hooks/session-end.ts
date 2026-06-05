#!/usr/bin/env bun
/**
 * @imsg/device — SessionEnd hook. Stop the per-session tap daemon.
 *
 * Touch the shutdown sentinel AND SIGTERM the daemon (belt + suspenders), then
 * clean up. Note: SessionEnd is best-effort — a SIGKILL / crash / reboot skips
 * it, which is why the daemon ALSO self-exits via its own lsof orphan check.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  migrateLegacyDeviceDir,
  sessionAliveFile,
  sessionPidFile,
  sessionShutdownFile,
} from '../src/config.ts';
import { clearHandshakeForProject } from '../src/handshake.ts';

// Relocate pre-0.1.7 state into ~/.imsg before touching session files.
migrateLegacyDeviceDir();

const raw = await Bun.stdin.text();
let input: Record<string, unknown> = {};
try {
  input = JSON.parse(raw) as Record<string, unknown>;
} catch {
  /* malformed hook input */
}
const sessionId = String(input['session_id'] ?? '');
if (!sessionId) process.exit(0);

// Drop the SessionStart handshake so a finished session leaves none behind for a
// later same-dir session to read stale (scoped: only if it's ours).
const projectDir =
  (process.env.CLAUDE_PROJECT_DIR && process.env.CLAUDE_PROJECT_DIR.trim()) ||
  String(input['cwd'] ?? '') ||
  process.cwd();
clearHandshakeForProject(projectDir, sessionId);

// Signal the daemon to stop.
try {
  writeFileSync(sessionShutdownFile(sessionId), '');
} catch {
  /* ignore */
}

const pidFile = sessionPidFile(sessionId);
if (existsSync(pidFile)) {
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isFinite(pid)) process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  try {
    rmSync(pidFile, { force: true });
  } catch {
    /* ignore */
  }
}

// Drop the liveness sentinel so a same-id resume's ensureTap respawns the tap
// rather than seeing a recent mtime and assuming the (now-killed) tap is alive.
try {
  rmSync(sessionAliveFile(sessionId), { force: true });
} catch {
  /* ignore */
}

// Remove the sentinel — the daemon already got SIGTERM, and leaving it would make
// a same-id resume's daemon exit immediately. (SessionStart also clears it.)
try {
  rmSync(sessionShutdownFile(sessionId), { force: true });
} catch {
  /* ignore */
}
// NOTE: the per-session .title file is intentionally NOT removed here. A session
// shorter than the heartbeat interval may have written the title locally but not
// yet shipped it; deleting on SessionEnd would race that delivery. It's a tiny
// file and leaks the same way .cursor.json / .activity.jsonl already do — a
// holistic sessionsDir cleanup is the right place to reclaim all three.
process.exit(0);
