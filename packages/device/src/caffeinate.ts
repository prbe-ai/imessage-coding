/**
 * @imsg/device — macOS keep-awake (`caffeinate`) lifecycle, bound to AFK.
 *
 * While AFK is ON the user is driving this Mac remotely over iMessage. If the Mac
 * idle-sleeps, its network — and the iMessage bridge with it — drops, and the
 * remote session is lost. (The "lost connection" handling only DETECTS that; it
 * can't prevent it.) So we hold a `caffeinate` power assertion for exactly the
 * window AFK is on: spawned when AFK flips ON, killed when it flips OFF.
 *
 * The toggle runs in short-lived contexts (the `imsg afk` CLI; the channel
 * server's SSE down-push), so the assertion can't live in-process — we spawn
 * caffeinate DETACHED and track it by a machine-wide pid file (caffeinatePidFile).
 * reconcileCaffeinate() is called at BOTH AFK write sites; it's idempotent and a
 * no-op off macOS (caffeinate is macOS-only, so Codex-on-Linux stays clean).
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AfkState } from '@imsg/shared';
import { caffeinatePidFile, logDir } from './config.ts';

/**
 * caffeinate flags: `-i` prevents the system from idle-sleeping (effective on
 * battery AND AC); `-s` prevents system sleep on AC power. Together they keep the
 * Mac — and its network/iMessage bridge — awake. We deliberately OMIT `-d` so the
 * DISPLAY may still sleep: a dark screen doesn't drop the connection, and keeping
 * it lit would just burn power. caffeinate holds these assertions until the
 * process is killed (no `-t` timeout) — that's how its lifetime tracks AFK.
 */
const CAFFEINATE_ARGS = ['-i', '-s'] as const;

/** The `comm` basename `ps` reports for our process; used to confirm a tracked pid
 *  is really caffeinate before we kill it (recycled-pid guard). */
const CAFFEINATE_COMM = /(?:^|\/)caffeinate$/m;

function clog(event: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(logDir(), { recursive: true });
    appendFileSync(
      join(logDir(), 'caffeinate.log'),
      JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n',
    );
  } catch {
    /* best-effort — logging must never break a toggle */
  }
}

/** Pure: caffeinate is macOS-only. Injectable platform for tests. */
export function isMacOS(platform: string = process.platform): boolean {
  return platform === 'darwin';
}

/** What reconcile should do given the target AFK state and whether our tracked
 *  caffeinate is currently alive. Pure + exhaustive, so the decision is unit-
 *  testable without touching real processes. */
export enum CaffeinateAction {
  START = 'start',
  STOP = 'stop',
  NOOP = 'noop',
}

export function caffeinateActionFor(afk: AfkState, alive: boolean): CaffeinateAction {
  if (afk === AfkState.ON) return alive ? CaffeinateAction.NOOP : CaffeinateAction.START;
  return alive ? CaffeinateAction.STOP : CaffeinateAction.NOOP;
}

function readPid(): number | null {
  try {
    const n = Number.parseInt(readFileSync(caffeinatePidFile(), 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

function writePid(pid: number): void {
  const f = caffeinatePidFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, String(pid), 'utf8');
}

function clearPid(): void {
  try {
    rmSync(caffeinatePidFile());
  } catch {
    /* already gone */
  }
}

/**
 * True iff `pid` is a LIVE caffeinate — not a recycled pid now owned by an
 * unrelated process. `ps -o comm=` prints the executable name/path; matching the
 * caffeinate basename means a later kill can never hit something else.
 */
function isCaffeinateAlive(pid: number): boolean {
  try {
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    return r.status === 0 && CAFFEINATE_COMM.test((r.stdout ?? '').trim());
  } catch {
    return false;
  }
}

function startCaffeinate(): void {
  try {
    const child = spawn('caffeinate', [...CAFFEINATE_ARGS], { detached: true, stdio: 'ignore' });
    child.unref(); // outlive this (short-lived) process; we re-find it via the pid file
    if (child.pid) {
      writePid(child.pid);
      clog('started', { pid: child.pid, args: CAFFEINATE_ARGS });
    }
  } catch (err) {
    clog('start_error', { error: err instanceof Error ? err.message : String(err) });
  }
}

function stopCaffeinate(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM'); // caffeinate exits cleanly on SIGTERM, releasing the assertion
    clog('stopped', { pid });
  } catch (err) {
    clog('stop_error', { pid, error: err instanceof Error ? err.message : String(err) });
  } finally {
    clearPid();
  }
}

/**
 * Reconcile the keep-awake process to `afk`: spawn caffeinate when AFK is ON,
 * kill it when AFK is OFF. Best-effort and NEVER throws — a failure here must not
 * break the AFK toggle itself. No-op off macOS.
 *
 * Idempotent via the machine-wide pid file: a live tracked caffeinate is left
 * running; a dead/stale one is replaced (ON) or cleaned up (OFF). Called at BOTH
 * AFK write sites — the `imsg afk` CLI (`/afk` command + `$afk` skill) and the SSE
 * down-push that mirrors a remote/dashboard toggle.
 *
 * Concurrency: the CLI path is single-process. The SSE path runs in every live
 * session's channel server, so an AFK-ON pushed to N sessions at once can, in a
 * tight race, spawn more than one caffeinate (only the last pid is tracked). That
 * extra assertion is benign — its sole effect is the Mac staying awake slightly
 * longer than needed; it can never CAUSE the sleep/disconnect we guard against.
 * The tracked process is always killed on AFK-off; a rare orphan clears on reboot.
 * We accept that over adding a lock for a fail-safe edge.
 */
export function reconcileCaffeinate(afk: AfkState): void {
  if (!isMacOS()) return;
  try {
    const pid = readPid();
    const alive = pid !== null && isCaffeinateAlive(pid);
    switch (caffeinateActionFor(afk, alive)) {
      case CaffeinateAction.START:
        startCaffeinate();
        break;
      case CaffeinateAction.STOP:
        if (pid !== null) stopCaffeinate(pid);
        break;
      case CaffeinateAction.NOOP:
        // AFK off with a dead/stale pid still on disk: drop it so it can't shadow a
        // future liveness check (a recycled pid reading as "alive caffeinate").
        if (afk === AfkState.OFF && pid !== null) clearPid();
        break;
    }
  } catch (err) {
    clog('reconcile_error', { afk, error: err instanceof Error ? err.message : String(err) });
  }
}
