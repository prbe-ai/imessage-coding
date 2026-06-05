/**
 * @imsg/device — Codex session-id derivation from the parent process's rollout.
 *
 * WHY THIS EXISTS: Claude Code hands a plugin's long-lived MCP server its real
 * session id via CLAUDE_CODE_SESSION_ID (env). Codex hands the MCP server NOTHING
 * session-scoped — verified on codex-cli 0.137.0: no env var, no MCP roots, no
 * `initialize` field, and no session variable to template into the MCP config.
 * So a Codex-spawned channel server can't know which session it belongs to, and
 * the project-dir-keyed handshake (handshake.ts) collides when several agents run
 * in the same directory — the server can adopt a *different* session's id.
 *
 * But Codex spawns the MCP server as a CHILD of the codex session process, and
 * that codex process holds its rollout file OPEN — and the rollout filename
 * carries the session's v7 UUID (the exact id the tap daemon tails). So we walk
 * up from our own parent pid, list each ancestor's open files, and read the id
 * straight off the rollout path. This is per-session correct even with N codex
 * sessions sharing one directory, because each MCP server has its own parent
 * codex process holding its own rollout.
 *
 * macOS/Linux only (uses `lsof` + `ps`); on failure the caller falls back to the
 * handshake then a random id, i.e. no worse than before.
 */
import { execFileSync } from 'node:child_process';

/** Injectable command runner (real impl shells out; tests stub it). Returns
 *  stdout; throws on non-zero exit / spawn error (callers treat that as "no data"). */
export type ExecFn = (cmd: string, args: string[]) => string;

// Short timeout: lsof/ps normally return in single-digit ms (or fail instantly
// when the process is gone). execFileSync blocks the event loop, and this runs in
// the channel boot poll loop, so cap each call low — a hung lsof must not stall the
// MCP server. Derivation just needs a filename, not 2s of patience.
const EXEC_TIMEOUT_MS = 500;
const defaultExec: ExecFn = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Extract a Codex rollout session id from a file path, or null. Requires the
 * path to be an actual codex rollout (`…/.codex/sessions/…/rollout-….jsonl`) so
 * an unrelated open file can't masquerade as a session id. The id is the trailing
 * UUID in the filename (the leading `…T21-00-37` timestamp is not UUID-shaped, so
 * it never matches).
 */
export function rolloutSessionId(path: string): string | null {
  if (!/(?:^|\/)\.codex\/sessions\//.test(path)) return null;
  const file = path.slice(path.lastIndexOf('/') + 1);
  if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) return null;
  const id = file.match(UUID_RE)?.[1];
  return id ? id.toLowerCase() : null;
}

/** Open file paths held by `pid`, via `lsof -a -p <pid> -Fn` (name lines start
 *  with 'n'). Empty on any failure (no perms, process gone, lsof absent). */
function openFiles(pid: number, exec: ExecFn): string[] {
  try {
    const out = exec('lsof', ['-a', '-p', String(pid), '-Fn']);
    const paths: string[] = [];
    for (const line of out.split('\n')) {
      if (line.startsWith('n')) paths.push(line.slice(1));
    }
    return paths;
  } catch {
    return [];
  }
}

/** Parent pid of `pid` via `ps -o ppid= -p <pid>`, or null if unavailable / <=1. */
function ppidOf(pid: number, exec: ExecFn): number | null {
  try {
    const n = Number.parseInt(exec('ps', ['-o', 'ppid=', '-p', String(pid)]).trim(), 10);
    return Number.isFinite(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Derive this Codex session's id by walking up the process tree from `startPid`
 * (default: our own parent) up to `maxDepth` ancestors, returning the rollout id
 * from the first ancestor that holds a codex rollout file open. Normally the
 * direct parent IS the codex process; the walk is defense for an intervening
 * wrapper (e.g. a shell). Returns null if no rollout is found.
 */
export function deriveCodexSessionId(
  opts: { startPid?: number; maxDepth?: number; exec?: ExecFn } = {},
): string | null {
  const exec = opts.exec ?? defaultExec;
  const maxDepth = opts.maxDepth ?? 4;
  let pid: number | null = opts.startPid ?? process.ppid;
  for (let depth = 0; depth < maxDepth && pid && pid > 1; depth++) {
    for (const f of openFiles(pid, exec)) {
      const id = rolloutSessionId(f);
      if (id) return id;
    }
    pid = ppidOf(pid, exec);
  }
  return null;
}
