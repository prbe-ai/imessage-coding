import { describe, expect, test } from 'bun:test';
import { AfkState } from '@imsg/shared';
import { CaffeinateAction, caffeinateActionFor, isMacOS } from './caffeinate.ts';

describe('isMacOS', () => {
  test('darwin is macOS', () => {
    expect(isMacOS('darwin')).toBe(true);
  });
  test('non-darwin platforms are not macOS (caffeinate no-op there)', () => {
    expect(isMacOS('linux')).toBe(false);
    expect(isMacOS('win32')).toBe(false);
  });
});

describe('caffeinateActionFor', () => {
  test('AFK on + no live process → START (begin keep-awake)', () => {
    expect(caffeinateActionFor(AfkState.ON, false)).toBe(CaffeinateAction.START);
  });
  test('AFK on + already alive → NOOP (idempotent, do not double-spawn)', () => {
    expect(caffeinateActionFor(AfkState.ON, true)).toBe(CaffeinateAction.NOOP);
  });
  test('AFK off + live process → STOP (release keep-awake)', () => {
    expect(caffeinateActionFor(AfkState.OFF, true)).toBe(CaffeinateAction.STOP);
  });
  test('AFK off + nothing running → NOOP', () => {
    expect(caffeinateActionFor(AfkState.OFF, false)).toBe(CaffeinateAction.NOOP);
  });
});
