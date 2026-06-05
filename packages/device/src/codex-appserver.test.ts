/**
 * Unit tests for the Codex app-server injector's pure helpers.
 *
 * The WebSocket round-trip in injectReply() needs a live `codex app-server`, so it
 * is exercised by the manual spike + smoke harness, not here. This covers the one
 * pure decision: the turn/start payload shape.
 */
import { describe, expect, test } from 'bun:test';
import { buildTurnStartParams, AppServerMethod } from './codex-appserver.ts';

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
});

describe('AppServerMethod', () => {
  test('pins the protocol method strings', () => {
    expect(AppServerMethod.INITIALIZE).toBe('initialize');
    expect(AppServerMethod.INITIALIZED).toBe('initialized');
    expect(AppServerMethod.TURN_START).toBe('turn/start');
  });
});
