/**
 * Unit tests for the tap supervisor (ensureTap).
 *
 * The whole point of ensureTap is RELIABILITY: a session that captured zero
 * history used to stay dead because the spawn only happened on SessionStart and a
 * crashed tap was invisible. These tests pin the recovery behavior:
 *   - liveness is a FRESHNESS sentinel, not a bare pid (a recycled pid must NOT
 *     read as alive — that's the false-alive bug),
 *   - a stale/missing sentinel respawns; a fresh one is a cheap no-op,
 *   - the paired + killswitch + concrete-transcript guards hold,
 *   - the Codex branch passes IMSG_AGENT_KIND through to the spawn.
 *
 * The spawn is injected (TapSpawner) so we assert the DECISION without forking a
 * real bun tap process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentKind } from '@imsg/shared';
import { disabledFile, sessionAliveFile, sessionPidFile, sessionsDir } from './config.ts';
import {
  TAP_ALIVE_STALE_MS,
  type TapChild,
  type TapSpawner,
  ensureTap,
  isFresh,
  tapAlive,
} from './tap-spawn.ts';

const SID = '11111111-2222-3333-4444-555555555555';
const NOW = 1_000_000_000_000;

let dir: string;
let prevDir: string | undefined;
let prevToken: string | undefined;

/** Record every spawn so a test can assert it did / didn't fire and with what env. */
function recordingSpawner(): { spawn: TapSpawner; calls: NodeJS.ProcessEnv[] } {
  const calls: NodeJS.ProcessEnv[] = [];
  const spawn: TapSpawner = (_sid, _tp, _cwd, env) => {
    calls.push(env);
    const child: TapChild = { pid: 4242, unref() {} };
    return child;
  };
  return { spawn, calls };
}

/** A concrete transcript file so the existsSync guard passes. */
function makeTranscript(): string {
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, '{}\n');
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imsg-tapspawn-'));
  prevDir = process.env.IMSG_DEVICE_DIR;
  prevToken = process.env.IMSG_DEVICE_TOKEN;
  process.env.IMSG_DEVICE_DIR = dir;
  process.env.IMSG_DEVICE_TOKEN = 'paired-test-token'; // loadToken: env beats keychain/file
  mkdirSync(sessionsDir(), { recursive: true }); // so pre-written sentinels land
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.IMSG_DEVICE_DIR;
  else process.env.IMSG_DEVICE_DIR = prevDir;
  if (prevToken === undefined) delete process.env.IMSG_DEVICE_TOKEN;
  else process.env.IMSG_DEVICE_TOKEN = prevToken;
  rmSync(dir, { recursive: true, force: true });
});

describe('isFresh', () => {
  test('within the window is fresh', () => {
    expect(isFresh(NOW - (TAP_ALIVE_STALE_MS - 1), NOW)).toBe(true);
  });
  test('at/after the window is stale', () => {
    expect(isFresh(NOW - TAP_ALIVE_STALE_MS, NOW)).toBe(false);
    expect(isFresh(NOW - 2 * TAP_ALIVE_STALE_MS, NOW)).toBe(false);
  });
});

describe('tapAlive', () => {
  test('missing sentinel → not alive', () => {
    expect(tapAlive(SID, NOW)).toBe(false);
  });
  test('fresh sentinel → alive', () => {
    writeFileSync(sessionAliveFile(SID), '');
    expect(tapAlive(SID)).toBe(true);
  });
  test('stale sentinel → not alive', () => {
    const p = sessionAliveFile(SID);
    writeFileSync(p, '');
    const oldSec = (Date.now() - TAP_ALIVE_STALE_MS - 60_000) / 1000;
    utimesSync(p, oldSec, oldSec);
    expect(tapAlive(SID)).toBe(false);
  });
});

describe('ensureTap guards (no spawn)', () => {
  test('skips when transcript path is empty', () => {
    const { spawn, calls } = recordingSpawner();
    expect(ensureTap({ sessionId: SID, transcriptPath: '', cwd: dir, spawnTap: spawn })).toBe(
      'skipped',
    );
    expect(calls.length).toBe(0);
  });
  test('skips when the transcript file does not exist', () => {
    const { spawn, calls } = recordingSpawner();
    expect(
      ensureTap({ sessionId: SID, transcriptPath: join(dir, 'nope.jsonl'), cwd: dir, spawnTap: spawn }),
    ).toBe('skipped');
    expect(calls.length).toBe(0);
  });
  // NOTE: the `!loadToken()` (unpaired) half of the same guard line isn't unit
  // tested here — loadToken falls back to the macOS keychain, which holds a real
  // token on a paired dev machine, so env alone can't force it null. The killswitch
  // case below exercises the identical guard line's second half.
  test('skips when locally killswitched', () => {
    writeFileSync(disabledFile(), '');
    const { spawn, calls } = recordingSpawner();
    expect(
      ensureTap({ sessionId: SID, transcriptPath: makeTranscript(), cwd: dir, spawnTap: spawn }),
    ).toBe('skipped');
    expect(calls.length).toBe(0);
  });
});

describe('ensureTap spawn decision', () => {
  test('fresh tap → alive, no spawn', () => {
    writeFileSync(sessionAliveFile(SID), ''); // a healthy tap just touched it
    const { spawn, calls } = recordingSpawner();
    expect(
      ensureTap({ sessionId: SID, transcriptPath: makeTranscript(), cwd: dir, spawnTap: spawn }),
    ).toBe('alive');
    expect(calls.length).toBe(0);
  });

  test('missing sentinel → spawns and writes pid + alive', () => {
    const { spawn, calls } = recordingSpawner();
    const tp = makeTranscript();
    expect(ensureTap({ sessionId: SID, transcriptPath: tp, cwd: dir, spawnTap: spawn })).toBe(
      'spawned',
    );
    expect(calls.length).toBe(1);
    expect(existsSync(sessionAliveFile(SID))).toBe(true); // claimed immediately
    expect(readFileSync(sessionPidFile(SID), 'utf8')).toBe('4242');
  });

  test('STALE sentinel respawns even when a pid is live (recycled-pid false-alive)', () => {
    // Simulate the exact bug: a pidfile points at a LIVE pid (this test process),
    // but the tap is actually dead so its sentinel is stale. Freshness — not the
    // pid — must govern, so ensureTap respawns.
    writeFileSync(sessionPidFile(SID), String(process.pid)); // a real, live pid
    const p = sessionAliveFile(SID);
    writeFileSync(p, '');
    const oldSec = (Date.now() - TAP_ALIVE_STALE_MS - 60_000) / 1000;
    utimesSync(p, oldSec, oldSec);
    const { spawn, calls } = recordingSpawner();
    expect(
      ensureTap({ sessionId: SID, transcriptPath: makeTranscript(), cwd: dir, spawnTap: spawn }),
    ).toBe('spawned');
    expect(calls.length).toBe(1);
  });

  test('Codex branch passes IMSG_AGENT_KIND=codex to the spawn', () => {
    const { spawn, calls } = recordingSpawner();
    ensureTap({
      sessionId: SID,
      transcriptPath: makeTranscript(),
      cwd: dir,
      agentKind: AgentKind.CODEX,
      spawnTap: spawn,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.IMSG_AGENT_KIND).toBe(AgentKind.CODEX);
  });

  test('Claude Code branch does NOT set IMSG_AGENT_KIND', () => {
    delete process.env.IMSG_AGENT_KIND;
    const { spawn, calls } = recordingSpawner();
    ensureTap({ sessionId: SID, transcriptPath: makeTranscript(), cwd: dir, spawnTap: spawn });
    expect(calls[0]?.IMSG_AGENT_KIND).toBeUndefined();
  });

  test('sessionsDir is created on spawn', () => {
    const { spawn } = recordingSpawner();
    ensureTap({ sessionId: SID, transcriptPath: makeTranscript(), cwd: dir, spawnTap: spawn });
    expect(existsSync(sessionsDir())).toBe(true);
  });
});
