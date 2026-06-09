/**
 * Unit tests for the Codex app-server injector's pure helpers.
 *
 * The WebSocket round-trip in injectReply() needs a live `codex app-server`, so it
 * is exercised by the manual spike + smoke harness, not here. This covers the one
 * pure decision: the turn/start payload shape.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildTurnStartParams,
  singleLoadedThreadId,
  AppServerMethod,
  CODEX_EXPECT_REPLY_DIRECTIVE,
} from './codex-appserver.ts';

describe('buildTurnStartParams', () => {
  test('wraps the text as a single text UserInput under the thread id', () => {
    expect(buildTurnStartParams('019e99c3-437a-7b93-963b-a98eb03ae739', 'hello there')).toEqual({
      threadId: '019e99c3-437a-7b93-963b-a98eb03ae739',
      input: [{ type: 'text', text: 'hello there' }],
    });
  });

  test('preserves the text verbatim (no trimming / mutation)', () => {
    const text = '  multi\nline  reply  ';
    expect(buildTurnStartParams('t', text).input[0]!.text).toBe(text);
  });

  test('no expect-reply directive for a plain steer (expectReply omitted/false)', () => {
    expect(buildTurnStartParams('t', 'just do it').input[0]!.text).toBe('just do it');
    expect(buildTurnStartParams('t', 'just do it', false).input[0]!.text).toBe('just do it');
  });

  test('prepends the expect-reply directive (text preserved after it) when expectReply', () => {
    const text = 'what is the migration status?';
    const out = buildTurnStartParams('t', text, true).input[0]!.text;
    expect(out).toBe(`${CODEX_EXPECT_REPLY_DIRECTIVE}\n\n${text}`);
    expect(out.startsWith(CODEX_EXPECT_REPLY_DIRECTIVE)).toBe(true);
    expect(out.endsWith(text)).toBe(true);
  });

  test('the directive names the message_user tool so the agent knows how to reply', () => {
    expect(CODEX_EXPECT_REPLY_DIRECTIVE).toContain('message_user');
  });
});

describe('singleLoadedThreadId', () => {
  test('returns the id when exactly one thread is loaded (the per-session case)', () => {
    expect(singleLoadedThreadId(['019e9a88-4277-7611-a990-6fe48894069e'])).toBe(
      '019e9a88-4277-7611-a990-6fe48894069e',
    );
  });

  test('null when no thread is loaded yet (caller retries / falls back)', () => {
    expect(singleLoadedThreadId([])).toBeNull();
  });

  test('null when MORE than one is loaded (ambiguous — never the per-session model)', () => {
    expect(singleLoadedThreadId(['a-id', 'b-id'])).toBeNull();
  });

  test('null on non-array / malformed payloads', () => {
    expect(singleLoadedThreadId(undefined)).toBeNull();
    expect(singleLoadedThreadId(null)).toBeNull();
    expect(singleLoadedThreadId('019e')).toBeNull();
    expect(singleLoadedThreadId([42])).toBeNull(); // non-string entries filtered out → 0
  });
});

describe('AppServerMethod', () => {
  test('pins the protocol method strings', () => {
    expect(AppServerMethod.INITIALIZE).toBe('initialize');
    expect(AppServerMethod.INITIALIZED).toBe('initialized');
    expect(AppServerMethod.TURN_START).toBe('turn/start');
    expect(AppServerMethod.THREAD_LOADED_LIST).toBe('thread/loaded/list');
  });
});
