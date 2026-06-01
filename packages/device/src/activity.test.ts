/**
 * Unit tests for the transcript → lightweight activity extractor.
 *
 * Pins the product decisions for the AFK tap: ship user/assistant text + tool
 * markers, DROP thinking, DROP successful tool results (keep failures), DROP CC
 * bookkeeping / meta, and run surfaced text through secret redaction. Tool inputs
 * are reduced to a one-line summary; full inputs/results never appear.
 */
import { describe, expect, test } from 'bun:test';
import { ActivityKind } from '@imsg/shared';

import { extractActivity } from './activity.ts';

describe('extractActivity', () => {
  test('user text → USER_MESSAGE', () => {
    const out = extractActivity({ type: 'user', message: { role: 'user', content: 'add tests please' } });
    expect(out).toEqual([{ kind: ActivityKind.USER_MESSAGE, text: 'add tests please' }]);
  });

  test('assistant text + tool_use → ASSISTANT_TEXT + TOOL_USE summary (thinking dropped)', () => {
    const out = extractActivity({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me reason...', signature: 'BIGBLOB' },
          { type: 'text', text: "I'll run the tests." },
          { type: 'tool_use', name: 'Bash', input: { command: 'bun test\nsecond line' } },
        ],
      },
    });
    expect(out).toEqual([
      { kind: ActivityKind.ASSISTANT_TEXT, text: "I'll run the tests." },
      { kind: ActivityKind.TOOL_USE, toolName: 'Bash', summary: 'bun test' },
    ]);
  });

  test('tool_result: success dropped, error surfaced (no content)', () => {
    const ok = extractActivity({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'huge output' }] },
    });
    expect(ok).toEqual([]);
    const err = extractActivity({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'boom' }] },
    });
    expect(err).toEqual([{ kind: ActivityKind.TOOL_RESULT, isError: true }]);
  });

  test('tool_use summary prefers file_path when no command', () => {
    const out = extractActivity({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.ts', old_string: 'x' } }] },
    });
    expect(out).toEqual([{ kind: ActivityKind.TOOL_USE, toolName: 'Edit', summary: '/a/b.ts' }]);
  });

  test('drops CC bookkeeping and meta turns', () => {
    expect(extractActivity({ type: 'file-history-snapshot', foo: 1 })).toEqual([]);
    expect(extractActivity({ type: 'system', subtype: 'turn_duration' })).toEqual([]);
    expect(extractActivity({ type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } })).toEqual([]);
  });

  test('redacts secrets in surfaced text', () => {
    const out = extractActivity({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'key is sk-ant-abcdefghijklmnop1234567890 ok' }] },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.text).not.toContain('sk-ant-abcdefghijklmnop');
    expect(out[0]!.text).toContain('[redacted]');
  });

  test('non-object input yields nothing', () => {
    expect(extractActivity(null)).toEqual([]);
    expect(extractActivity('a string')).toEqual([]);
  });
});
