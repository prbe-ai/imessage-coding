/**
 * Unit tests for the Codex rollout → lightweight activity extractor.
 *
 * Pins the SAME product decisions as the CC reducer (activity.test.ts), applied
 * to Codex's RolloutItem variants: surface user/assistant text + tool markers,
 * DROP reasoning, DROP successful tool results (keep failures), DROP session
 * metadata / the agent_message UI mirror / token_count noise, drop developer +
 * startup-context preamble frames, and run surfaced text through secret
 * redaction. Tool inputs are reduced to a one-line summary; full inputs/results
 * never appear.
 *
 * The fixture `__fixtures__/codex-rollout-sample.jsonl` is the real captured
 * Codex session ("Say hello in five words. Do not call any tools.") captured
 * from an internal Codex tap plugin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ActivityKind } from '@imsg/shared';

import { extractCodexActivity, firstCodexUserMessage } from './transcript-codex.ts';

/** Wrap a payload in the rollout envelope Codex writes per line. */
const responseItem = (payload: Record<string, unknown>) => ({ type: 'response_item', timestamp: 't', payload });
const eventMsg = (payload: Record<string, unknown>) => ({ type: 'event_msg', timestamp: 't', payload });

describe('extractCodexActivity', () => {
  test('response_item.message role=user → USER_MESSAGE', () => {
    const out = extractCodexActivity(
      responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add tests please' }] }),
    );
    expect(out).toEqual([{ kind: ActivityKind.USER_MESSAGE, text: 'add tests please' }]);
  });

  test('response_item.message role=assistant → ASSISTANT_TEXT', () => {
    const out = extractCodexActivity(
      responseItem({
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Hello, hope you are well.' }],
      }),
    );
    expect(out).toEqual([{ kind: ActivityKind.ASSISTANT_TEXT, text: 'Hello, hope you are well.' }]);
  });

  test('developer-role message is dropped', () => {
    expect(
      extractCodexActivity(
        responseItem({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system rules' }] }),
      ),
    ).toEqual([]);
  });

  test('a startup-context user frame is dropped', () => {
    expect(
      extractCodexActivity(
        responseItem({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>' }],
        }),
      ),
    ).toEqual([]);
  });

  test('a real user message that merely mentions context words survives', () => {
    const out = extractCodexActivity(
      responseItem({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'why is <environment_context> showing up in search?' }],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe(ActivityKind.USER_MESSAGE);
    expect(out[0]!.text).toContain('why is');
  });

  test('function_call → one-line TOOL_USE marker (arguments JSON parsed for summary)', () => {
    const out = extractCodexActivity(
      responseItem({
        type: 'function_call',
        call_id: 'call_1',
        name: 'shell',
        arguments: JSON.stringify({ command: 'ls -la /etc/passwd\nsecond line' }),
      }),
    );
    expect(out).toEqual([{ kind: ActivityKind.TOOL_USE, toolName: 'shell', summary: 'ls -la /etc/passwd' }]);
  });

  test('local_shell_call → local_shell TOOL_USE with the joined command', () => {
    const out = extractCodexActivity(
      responseItem({
        type: 'local_shell_call',
        call_id: 'ls1',
        status: 'completed',
        action: { type: 'exec', command: ['bash', '-c', 'echo hi'] },
      }),
    );
    expect(out).toEqual([{ kind: ActivityKind.TOOL_USE, toolName: 'local_shell', summary: 'bash -c echo hi' }]);
  });

  test('custom_tool_call → TOOL_USE summarized from its input object', () => {
    const out = extractCodexActivity(
      responseItem({ type: 'custom_tool_call', call_id: 'c1', name: 'search', input: { query: 'needle' } }),
    );
    expect(out).toEqual([{ kind: ActivityKind.TOOL_USE, toolName: 'search', summary: 'needle' }]);
  });

  test('tool_result: success dropped, error surfaced (no content)', () => {
    const ok = extractCodexActivity(
      responseItem({ type: 'function_call_output', call_id: 'c1', output: 'done' }),
    );
    expect(ok).toEqual([]);
    const err = extractCodexActivity(
      responseItem({ type: 'function_call_output', call_id: 'c1', output: { is_error: true, content: 'permission denied' } }),
    );
    expect(err).toEqual([{ kind: ActivityKind.TOOL_RESULT, isError: true }]);
  });

  test('custom_tool_call_output error is surfaced', () => {
    const err = extractCodexActivity(
      responseItem({ type: 'custom_tool_call_output', call_id: 'c1', output: { is_error: true } }),
    );
    expect(err).toEqual([{ kind: ActivityKind.TOOL_RESULT, isError: true }]);
  });

  test('reasoning is dropped', () => {
    expect(
      extractCodexActivity(
        responseItem({ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thinking step' }], summary: [] }),
      ),
    ).toEqual([]);
  });

  test('session_meta / turn_context are dropped', () => {
    expect(extractCodexActivity({ type: 'session_meta', timestamp: 't', payload: { id: 'x', cli_version: '0.1' } })).toEqual([]);
    expect(extractCodexActivity({ type: 'turn_context', timestamp: 't', payload: { model: 'gpt-5.5' } })).toEqual([]);
  });

  test('event_msg variants are dropped (token_count + the message UI mirror)', () => {
    for (const sub of ['token_count', 'task_started', 'task_complete', 'user_message', 'agent_message']) {
      expect(extractCodexActivity(eventMsg({ type: sub, message: 'Hello, hope you are well.' }))).toEqual([]);
    }
  });

  test('redacts secrets in surfaced text', () => {
    const out = extractCodexActivity(
      responseItem({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'key is sk-ant-abcdefghijklmnop1234567890 ok' }],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.text).not.toContain('sk-ant-abcdefghijklmnop');
    expect(out[0]!.text).toContain('[redacted]');
  });

  test('non-object input yields nothing', () => {
    expect(extractCodexActivity(null)).toEqual([]);
    expect(extractCodexActivity('a string')).toEqual([]);
  });
});

// --- fixture-driven integration test ----------------------------------------
const FIXTURE = join(import.meta.dir, '__fixtures__', 'codex-rollout-sample.jsonl');
const fixtureLines = () => readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim());

describe('extractCodexActivity (fixture)', () => {
  test('the captured 5-word assistant reply survives the round-trip', () => {
    const activities = fixtureLines().flatMap((line) => extractCodexActivity(JSON.parse(line)));
    const assistant = activities.filter((a) => a.kind === ActivityKind.ASSISTANT_TEXT);
    expect(assistant).toEqual([{ kind: ActivityKind.ASSISTANT_TEXT, text: 'Hello, hope you are well.' }]);
  });

  test('exactly one user message survives (the real prompt; preamble frames dropped)', () => {
    const activities = fixtureLines().flatMap((line) => extractCodexActivity(JSON.parse(line)));
    const user = activities.filter((a) => a.kind === ActivityKind.USER_MESSAGE);
    expect(user).toEqual([{ kind: ActivityKind.USER_MESSAGE, text: 'Say hello in five words. Do not call any tools.' }]);
  });

  test('reasoning, token_count and the event_msg UI mirror leave no trace', () => {
    const lines = fixtureLines();
    const serialized = JSON.stringify(lines.flatMap((line) => extractCodexActivity(JSON.parse(line))));
    // The encrypted reasoning blob, the startup preamble, and developer rules
    // are all dropped — none of their distinctive content reaches the stream.
    expect(serialized).not.toContain('gAAAAA'); // encrypted reasoning content
    expect(serialized).not.toContain('environment_context');
    expect(serialized).not.toContain('skills_instructions');
    // event_msg.agent_message mirrors the assistant reply — it must not double it.
    const activities = lines.flatMap((line) => extractCodexActivity(JSON.parse(line)));
    expect(activities.filter((a) => a.text === 'Hello, hope you are well.')).toHaveLength(1);
  });
});

describe('firstCodexUserMessage', () => {
  test('returns the first real user prompt, skipping preamble frames', () => {
    expect(firstCodexUserMessage(fixtureLines())).toBe('Say hello in five words. Do not call any tools.');
  });

  test('null when no user message is present', () => {
    const lines = [
      JSON.stringify(responseItem({ type: 'reasoning', content: [], summary: [] })),
      JSON.stringify(eventMsg({ type: 'token_count', info: null })),
    ];
    expect(firstCodexUserMessage(lines)).toBeNull();
  });

  test('skips unparseable lines', () => {
    const lines = [
      '{ not json',
      JSON.stringify(responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real one' }] })),
    ];
    expect(firstCodexUserMessage(lines)).toBe('real one');
  });
});
