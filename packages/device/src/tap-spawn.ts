/**
 * @imsg/device — shared per-session tap daemon supervisor (ensureTap).
 *
 * The SessionStart hooks AND the per-turn hooks (UserPromptSubmit / Stop, for both
 * Claude Code and Codex) all need the same thing: "make sure a tap daemon is
 * tailing this session's transcript, and is actually ALIVE." Centralizing the
 * spawn decision here (instead of duplicating it in each hook) is what lets the
 * device recover the ~30% of CC sessions + 100% of Codex sessions that used to
 * capture zero history:
 *
 *   - A session already running when the plugin is installed/updated never fired a
 *     SessionStart, so it never got a tap. Its next prompt/turn fires a per-turn
 *     hook → ensureTap spawns one.
 *   - A tap that crashed (detached, stdio ignored — invisible) used to stay dead.
 *     The next per-turn hook sees a STALE liveness sentinel → respawns it.
 *   - Codex sets transcript_path NULL on SessionStart (the rollout file doesn't
 *     exist yet), so its SessionStart can't spawn a tap. The first UserPromptSubmit
 *     (rollout now written) → ensureTap finally spawns it.
 *
 * Liveness is a FRESHNESS sentinel (`<id>.alive`), NOT a bare `kill(pid, 0)`: the
 * tap touches the sentinel every loop iteration, so a crashed tap — or a pidfile
 * pointing at a pid an unrelated process later recycled — reads as stale and is
 * respawned. The pidfile is kept only for SessionEnd's SIGTERM teardown.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentKind } from '@imsg/shared';
import {
  logDir,
  pluginRoot,
  sessionAliveFile,
  sessionPidFile,
  sessionShutdownFile,
  sessionsDir,
} from './config.ts';
import { loadToken } from './creds.ts';
import { localDisabled } from './killswitch.ts';

/**
 * A tap counts as alive iff its `<id>.alive` sentinel was touched within this
 * window. Must comfortably exceed the tap's IDLE_INTERVAL_MS (120s) — an idle tap
 * only touches the sentinel once per idle tick. 5 min ≈ 2.5× the idle interval, so
 * a live-but-quiet tap is never falsely respawned, while a truly dead one is
 * recovered within a few minutes (on the next hook).
 */
export const TAP_ALIVE_STALE_MS = 5 * 60_000;

/** What ensureTap did, for logging + unit tests. */
export type EnsureTapResult = 'alive' | 'spawned' | 'skipped';

/** Minimal child handle ensureTap needs — satisfied by node's ChildProcess and by
 *  a test stub, so the spawn can be injected without launching a real tap. */
export interface TapChild {
  pid?: number | undefined;
  unref(): void;
}

/** Launches the detached tap process. Injectable so tests assert the spawn
 *  decision (stale → spawn, fresh → skip) without forking a real bun process. */
export type TapSpawner = (
  sessionId: string,
  transcriptPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) => TapChild;

const realSpawner: TapSpawner = (sessionId, transcriptPath, cwd, env) => {
  const tapPath = join(pluginRoot(), 'bin', 'tap.ts');
  return spawn(
    process.execPath, // the bun binary running this hook
    [tapPath, '--session-id', sessionId, '--transcript', transcriptPath, '--cwd', cwd],
    { detached: true, stdio: 'ignore', cwd: pluginRoot(), env },
  );
};

function spawnLog(event: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(logDir(), { recursive: true });
    appendFileSync(
      join(logDir(), 'tap-spawn.log'),
      JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n',
    );
  } catch {
    /* best-effort */
  }
}

/** Pure freshness decision (mtime injectable for tests). */
export function isFresh(mtimeMs: number, now: number): boolean {
  return now - mtimeMs < TAP_ALIVE_STALE_MS;
}

/** True iff a tap for `sessionId` is alive (its `.alive` sentinel is fresh). */
export function tapAlive(sessionId: string, now: number = Date.now()): boolean {
  try {
    return isFresh(statSync(sessionAliveFile(sessionId)).mtimeMs, now);
  } catch {
    return false; // no sentinel → treat as not alive
  }
}

/**
 * Ensure a tap daemon is tailing `transcriptPath` for `sessionId`. Idempotent and
 * cheap (one stat when a healthy tap already exists). Safe to call from any hook
 * on any event.
 *
 * Guards (mirror the SessionStart hooks): needs a real session id + an existing
 * transcript path, a paired token, and egress not locally killswitched. Returns
 * what it did so callers/tests can assert.
 */
export function ensureTap(opts: {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  agentKind?: AgentKind;
  /** Injectable clock for the freshness check (tests). */
  now?: number;
  /** Injectable spawner (tests); defaults to the real detached spawn. */
  spawnTap?: TapSpawner;
}): EnsureTapResult {
  const { sessionId, transcriptPath, cwd, now = Date.now(), spawnTap = realSpawner } = opts;
  // The byte-offset tailer needs a concrete file; for Codex the rollout often does
  // not exist yet on the first hook fire — skip quietly and let a later hook retry.
  if (!sessionId || !transcriptPath || !existsSync(transcriptPath)) return 'skipped';
  if (!loadToken() || localDisabled()) return 'skipped';

  if (tapAlive(sessionId, now)) return 'alive';

  // (Re)spawn. Clear any stale shutdown sentinel from a prior run of this id.
  mkdirSync(sessionsDir(), { recursive: true });
  try {
    rmSync(sessionShutdownFile(sessionId), { force: true });
  } catch {
    /* ignore */
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.agentKind === AgentKind.CODEX) env.IMSG_AGENT_KIND = AgentKind.CODEX;

  const child = spawnTap(sessionId, transcriptPath, cwd, env);
  child.unref();

  // Claim liveness immediately so a near-simultaneous ensureTap (e.g. Stop firing
  // right after UserPromptSubmit) sees a fresh sentinel and does NOT double-spawn
  // before the new tap's first loop iteration touches it.
  try {
    writeFileSync(sessionAliveFile(sessionId), '');
  } catch {
    /* ignore */
  }
  try {
    writeFileSync(sessionPidFile(sessionId), String(child.pid ?? ''), 'utf8');
  } catch {
    /* ignore */
  }
  spawnLog('tap_spawned', {
    sessionId,
    pid: child.pid ?? null,
    agent: opts.agentKind ?? AgentKind.CLAUDE_CODE,
  });
  return 'spawned';
}
