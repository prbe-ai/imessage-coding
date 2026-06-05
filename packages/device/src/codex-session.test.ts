/**
 * Unit tests for Codex session-id derivation from the parent process's rollout.
 *
 * The real impl shells out to `lsof` + `ps`; both are injected here so the walk
 * logic and the path→id parsing are pinned without touching real processes. This
 * is the mechanism that lets a Codex-spawned MCP server learn its OWN session id
 * (Codex passes nothing session-scoped), so the parsing must reject anything that
 * isn't an actual codex rollout, and the walk must climb past a wrapper process.
 */
import { describe, expect, test } from 'bun:test';
import { deriveCodexSessionId, rolloutSessionId, type ExecFn } from './codex-session.ts';

const ID = '019e95f0-a704-73d2-9682-60f699d6660b';
const ROLLOUT = `/Users/richy/.codex/sessions/2026/06/04/rollout-2026-06-04T21-00-37-${ID}.jsonl`;

describe('rolloutSessionId', () => {
  test('extracts the trailing uuid from a real rollout path', () => {
    expect(rolloutSessionId(ROLLOUT)).toBe(ID);
  });

  test('normalizes an uppercase uuid to lowercase', () => {
    const upper = `/Users/richy/.codex/sessions/2026/06/04/rollout-2026-06-04T21-00-37-${ID.toUpperCase()}.jsonl`;
    expect(rolloutSessionId(upper)).toBe(ID);
  });

  test('the leading timestamp is not mistaken for the id', () => {
    // `2026-06-04T21-00-37` is not UUID-shaped, so only the trailing id matches.
    expect(rolloutSessionId(ROLLOUT)).toBe(ID);
  });

  test('rejects a non-codex path even when it ends in <uuid>.jsonl', () => {
    expect(rolloutSessionId(`/tmp/rollout-${ID}.jsonl`)).toBeNull();
  });

  test('rejects a codex file that is not a rollout', () => {
    expect(rolloutSessionId(`/Users/x/.codex/sessions/2026/history-${ID}.jsonl`)).toBeNull();
  });

  test('rejects a rollout with no uuid', () => {
    expect(rolloutSessionId('/Users/x/.codex/sessions/2026/rollout-2026-06-04.jsonl')).toBeNull();
  });
});

/** A fake process tree: pid → { open files, parent pid }. Drives both `lsof` and
 *  `ps` so the walk can be exercised deterministically. */
function fakeExec(tree: Record<number, { files?: string[]; ppid?: number }>): ExecFn {
  return (cmd, args) => {
    const pid = Number(args[args.indexOf('-p') + 1]);
    const node = tree[pid];
    if (!node) throw new Error(`no such pid ${pid}`);
    if (cmd === 'lsof') {
      const lines = [`p${pid}`];
      for (const f of node.files ?? []) lines.push('f10', `n${f}`);
      return `${lines.join('\n')}\n`;
    }
    if (cmd === 'ps') {
      if (node.ppid === undefined) throw new Error('no ppid');
      return `  ${node.ppid}\n`;
    }
    throw new Error(`unknown cmd ${cmd}`);
  };
}

describe('deriveCodexSessionId', () => {
  test('reads the id from the direct parent codex process', () => {
    const exec = fakeExec({ 100: { files: ['/etc/hosts', ROLLOUT], ppid: 1 } });
    expect(deriveCodexSessionId({ startPid: 100, exec })).toBe(ID);
  });

  test('walks up past a wrapper that holds no rollout', () => {
    const exec = fakeExec({
      100: { files: ['/dev/null'], ppid: 200 }, // intervening shell
      200: { files: [ROLLOUT], ppid: 1 }, // the codex process
    });
    expect(deriveCodexSessionId({ startPid: 100, exec })).toBe(ID);
  });

  test('returns null when no ancestor holds a rollout', () => {
    const exec = fakeExec({
      100: { files: ['/dev/null'], ppid: 200 },
      200: { files: ['/tmp/x'], ppid: 1 },
    });
    expect(deriveCodexSessionId({ startPid: 100, exec })).toBeNull();
  });

  test('respects maxDepth', () => {
    const exec = fakeExec({
      100: { files: [], ppid: 200 },
      200: { files: [], ppid: 300 },
      300: { files: [ROLLOUT], ppid: 1 },
    });
    expect(deriveCodexSessionId({ startPid: 100, exec, maxDepth: 2 })).toBeNull();
    expect(deriveCodexSessionId({ startPid: 100, exec, maxDepth: 3 })).toBe(ID);
  });

  test('treats lsof/ps failures as no data (never throws)', () => {
    const exec: ExecFn = () => {
      throw new Error('lsof: command not found');
    };
    expect(deriveCodexSessionId({ startPid: 100, exec })).toBeNull();
  });

  test('stops at pid <= 1 without looping forever', () => {
    const exec = fakeExec({ 100: { files: [], ppid: 1 } });
    expect(deriveCodexSessionId({ startPid: 100, exec })).toBeNull();
  });
});
