/**
 * @imsg/device — SessionStart → MCP-server session handshake.
 *
 * WHY THIS EXISTS: Claude Code does NOT expose the session id to a plugin's
 * long-lived MCP server (verified: the MCP server only gets CLAUDE_PROJECT_DIR /
 * CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA — nothing session-scoped, and nothing
 * in the MCP `initialize` or Channels params). The SessionStart HOOK, however,
 * receives {session_id, transcript_path, cwd}. So the hook drops a handshake file
 * keyed by the PROJECT DIR, and the MCP server reads it back by the same key
 * (`CLAUDE_PROJECT_DIR`, which IS in its env) to learn its real session id.
 *
 * This fixes the long-standing random-UUID session bug (channel.ts) so the MCP
 * server's `sessions` row, the SSE subscription, steering, and the daemon's
 * activity rows all key off ONE real id.
 *
 * Keying by project dir binds correctly for the supported workflow: parallel
 * sessions live in DISTINCT git worktrees (distinct project dirs). Two concurrent
 * sessions in the EXACT same directory can't be told apart (last writer wins) —
 * a documented limitation, acceptable because worktrees are the norm here.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deviceDir } from './config.ts';

export interface Handshake {
  sessionId: string;
  transcriptPath: string;
  /** The project dir (CC's CLAUDE_PROJECT_DIR) — also the heartbeat's real cwd. */
  cwd: string;
  /** ISO-8601 write time (so a reader can ignore an absurdly stale handshake). */
  at: string;
}

/** Directory holding per-project handshake files. */
export function handshakeDir(): string {
  return join(deviceDir(), 'handshakes');
}

/** Stable per-project filename (hash the path so it's filesystem-safe). */
export function handshakeFile(projectDir: string): string {
  const key = createHash('sha1').update(projectDir).digest('hex').slice(0, 16);
  return join(handshakeDir(), `${key}.json`);
}

/** Write (overwrite) the handshake for a project dir. Best-effort. */
export function writeHandshake(h: Handshake): void {
  const dir = handshakeDir();
  mkdirSync(dir, { recursive: true });
  const path = handshakeFile(h.cwd);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(h), 'utf8');
  // Atomic replace so a reader never sees a half-written file.
  renameSync(tmp, path);
}

/**
 * Delete the handshake for a project dir, but ONLY if it belongs to `sessionId`
 * (so a concurrent same-dir session that overwrote it isn't clobbered). Called by
 * SessionEnd so a finished session never leaves a stale handshake behind.
 */
export function clearHandshakeForProject(projectDir: string, sessionId: string): void {
  try {
    const h = readHandshakeForProject(projectDir);
    if (h?.sessionId === sessionId) rmSync(handshakeFile(projectDir), { force: true });
  } catch {
    /* best-effort */
  }
}

/** Read the handshake for a project dir, or null if absent/unparseable. */
export function readHandshakeForProject(projectDir: string): Handshake | null {
  try {
    const parsed = JSON.parse(readFileSync(handshakeFile(projectDir), 'utf8')) as Partial<Handshake>;
    if (
      typeof parsed.sessionId === 'string' &&
      parsed.sessionId &&
      typeof parsed.transcriptPath === 'string' &&
      typeof parsed.cwd === 'string'
    ) {
      return {
        sessionId: parsed.sessionId,
        transcriptPath: parsed.transcriptPath,
        cwd: parsed.cwd,
        at: typeof parsed.at === 'string' ? parsed.at : '',
      };
    }
  } catch {
    /* missing or malformed — caller falls back */
  }
  return null;
}
