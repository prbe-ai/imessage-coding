/**
 * Unit tests for the transcript tailer's pure line-splitter.
 *
 * The load-bearing guarantee: a PARTIAL trailing line (written mid-flush by
 * Claude Code) is NOT emitted and its bytes are reported so the cursor does not
 * advance past them — they get re-read once the newline lands. Blank lines are
 * skipped and CRLF is normalized.
 */
import { describe, expect, test } from 'bun:test';

import { agentMessagedSinceLastPrompt, splitLines } from './transcript.ts';

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

// --- transcript lines (the shapes Claude Code writes) -----------------------
const userPrompt = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const assistantText = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = (name: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input: { text: 'hi' } }] },
  });
const FQ_MESSAGE_USER = 'mcp__plugin_imsg-device_imsg-device__message_user';
// A tool_result is delivered as a USER-role message — it must NOT be treated as a
// turn boundary (otherwise a message_user before it would be missed).
const toolResult = () =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  });
const metaTurn = () =>
  JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>x' } });
// A Task subagent's message_user call — carries isSidechain:true; must NOT count
// as the MAIN agent reporting.
const sidechainMessageUser = () =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    message: { role: 'assistant', content: [{ type: 'tool_use', name: FQ_MESSAGE_USER, input: { text: 'sub' } }] },
  });
// An image-only user prompt (no text block) — still a real turn boundary.
const imageOnlyPrompt = () =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] },
  });

describe('agentMessagedSinceLastPrompt', () => {
  test('true when message_user was called after the last prompt', () => {
    expect(
      agentMessagedSinceLastPrompt([userPrompt('do it'), assistantText('working'), toolUse(FQ_MESSAGE_USER)]),
    ).toBe(true);
  });

  test('false when the turn ended with no message_user', () => {
    expect(agentMessagedSinceLastPrompt([userPrompt('do it'), assistantText('done')])).toBe(false);
  });

  test('false when message_user only happened in a PRIOR turn', () => {
    expect(
      agentMessagedSinceLastPrompt([
        userPrompt('first'),
        toolUse(FQ_MESSAGE_USER),
        userPrompt('second'), // newer prompt → boundary; nothing reported since
        assistantText('done'),
      ]),
    ).toBe(false);
  });

  test('matches the bare tool name (this package\'s own MCP server)', () => {
    expect(agentMessagedSinceLastPrompt([userPrompt('do it'), toolUse('message_user')])).toBe(true);
  });

  test('does not match an unrelated tool', () => {
    expect(agentMessagedSinceLastPrompt([userPrompt('do it'), toolUse('Bash')])).toBe(false);
  });

  test('a tool_result (user-role) is not a turn boundary', () => {
    expect(
      agentMessagedSinceLastPrompt([
        userPrompt('do it'),
        toolUse(FQ_MESSAGE_USER),
        toolResult(), // user-role, but NOT a prompt → scan keeps going past it
        assistantText('done'),
      ]),
    ).toBe(true);
  });

  test('a CC meta turn is not a turn boundary', () => {
    expect(
      agentMessagedSinceLastPrompt([userPrompt('do it'), toolUse(FQ_MESSAGE_USER), metaTurn(), assistantText('x')]),
    ).toBe(true);
  });

  test('skips unparseable lines', () => {
    expect(agentMessagedSinceLastPrompt(['{ not json', userPrompt('do it'), toolUse(FQ_MESSAGE_USER)])).toBe(true);
  });

  test('a subagent (sidechain) message_user does NOT satisfy the main-agent gate', () => {
    expect(
      agentMessagedSinceLastPrompt([userPrompt('do it'), sidechainMessageUser(), assistantText('done')]),
    ).toBe(false);
  });

  test('an image-only user prompt is still a turn boundary', () => {
    // message_user happened BEFORE this image-only prompt → not "this turn".
    expect(
      agentMessagedSinceLastPrompt([
        userPrompt('first'),
        toolUse(FQ_MESSAGE_USER),
        imageOnlyPrompt(), // boundary; nothing reported since
        assistantText('done'),
      ]),
    ).toBe(false);
  });

  test('empty transcript → false', () => {
    expect(agentMessagedSinceLastPrompt([])).toBe(false);
  });
});
