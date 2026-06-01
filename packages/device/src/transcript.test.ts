/**
 * Unit tests for the transcript tailer's pure line-splitter.
 *
 * The load-bearing guarantee: a PARTIAL trailing line (written mid-flush by
 * Claude Code) is NOT emitted and its bytes are reported so the cursor does not
 * advance past them — they get re-read once the newline lands. Blank lines are
 * skipped and CRLF is normalized.
 */
import { describe, expect, test } from 'bun:test';

import { splitLines } from './transcript.ts';

describe('splitLines', () => {
  test('emits complete lines, withholds a partial trailing line', () => {
    const { lines, partial } = splitLines(Buffer.from('a\nb\nc'));
    expect(lines).toEqual(['a', 'b']);
    expect(partial).toBe(1); // 'c' is unterminated
  });

  test('no partial when the buffer ends on a newline', () => {
    const { lines, partial } = splitLines(Buffer.from('a\nb\n'));
    expect(lines).toEqual(['a', 'b']);
    expect(partial).toBe(0);
  });

  test('skips blank lines and strips CRLF', () => {
    const { lines, partial } = splitLines(Buffer.from('a\r\n\r\nb\r\n'));
    expect(lines).toEqual(['a', 'b']);
    expect(partial).toBe(0);
  });

  test('a lone unterminated line is fully withheld', () => {
    const { lines, partial } = splitLines(Buffer.from('{"partial":'));
    expect(lines).toEqual([]);
    expect(partial).toBe('{"partial":'.length);
  });

  test('empty buffer', () => {
    const { lines, partial } = splitLines(Buffer.from(''));
    expect(lines).toEqual([]);
    expect(partial).toBe(0);
  });
});
