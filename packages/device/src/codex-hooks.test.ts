/**
 * Unit tests for the Codex hook decision core (src/codex-hooks.ts) — the pure,
 * unit-testable parts of the Codex AFK gates. We cannot drive a live `codex`
 * process here, so these pin the DECISIONS the hooks make:
 *
 *   - shouldBlockStop:        the AFK Stop gate incl. its self-limit (no loop).
 *   - decisionFromVerdict:    verdict → behavior, fail-CLOSED on every non-allow.
 *   - isDestructiveCodexTool: which Codex tools need approve-and-resume.
 *   - codexMessagedSinceLastPrompt: the turn-scoped message_user scan over a
 *                             Codex rollout (the input the Stop gate keys off).
 */
import { describe, expect, test } from 'bun:test';

import {
  PermissionBehavior,
  codexMessagedSinceLastPrompt,
  decisionFromVerdict,
  isDestructiveCodexTool,
  shouldBlockStop,
} from './codex-hooks.ts';

// --- shouldBlockStop ---------------------------------------------------------
describe('shouldBlockStop (AFK Stop gate)', () => {
  test('AFK off → never blocks, whatever the other flags', () => {
    expect(shouldBlockStop({ afk: false, stopHookActive: false, messagedThisTurn: false })).toBe(false);
    expect(shouldBlockStop({ afk: false, stopHookActive: true, messagedThisTurn: false })).toBe(false);
    expect(shouldBlockStop({ afk: false, stopHookActive: false, messagedThisTurn: true })).toBe(false);
  });

  test('AFK on + not reported + first block → BLOCKS (nudge to report)', () => {
    expect(shouldBlockStop({ afk: true, stopHookActive: false, messagedThisTurn: false })).toBe(true);
  });

  test('AFK on + already reported → allow (agent reached the user)', () => {
    expect(shouldBlockStop({ afk: true, stopHookActive: false, messagedThisTurn: true })).toBe(false);
  });

  test('AFK on + stop_hook_active → allow (self-limit: only one nudge, no loop)', () => {
    // Critical: Codex has no system loop cap on a blocking Stop hook, so even when
    // the agent STILL has not reported, a second fire must release.
    expect(shouldBlockStop({ afk: true, stopHookActive: true, messagedThisTurn: false })).toBe(false);
    expect(shouldBlockStop({ afk: true, stopHookActive: true, messagedThisTurn: true })).toBe(false);
  });
});

// --- decisionFromVerdict (fail-CLOSED) ---------------------------------------
describe('decisionFromVerdict (fail-closed)', () => {
  test('ok + behavior allow → ALLOW (the only path to allow)', () => {
    expect(decisionFromVerdict({ ok: true, behavior: 'allow' })).toBe(PermissionBehavior.ALLOW);
  });

  test('ok + behavior deny → DENY', () => {
    expect(decisionFromVerdict({ ok: true, behavior: 'deny' })).toBe(PermissionBehavior.DENY);
  });

  test('not ok (failed call / non-200) → DENY even if behavior says allow', () => {
    expect(decisionFromVerdict({ ok: false, behavior: 'allow' })).toBe(PermissionBehavior.DENY);
    expect(decisionFromVerdict({ ok: false })).toBe(PermissionBehavior.DENY);
  });

  test('ok but missing / garbage behavior → DENY (never silently allow)', () => {
    expect(decisionFromVerdict({ ok: true })).toBe(PermissionBehavior.DENY);
    expect(decisionFromVerdict({ ok: true, behavior: undefined })).toBe(PermissionBehavior.DENY);
    expect(decisionFromVerdict({ ok: true, behavior: null })).toBe(PermissionBehavior.DENY);
    expect(decisionFromVerdict({ ok: true, behavior: 'ALLOW' })).toBe(PermissionBehavior.DENY); // case-sensitive
    expect(decisionFromVerdict({ ok: true, behavior: 'yes' })).toBe(PermissionBehavior.DENY);
    expect(decisionFromVerdict({ ok: true, behavior: 1 })).toBe(PermissionBehavior.DENY);
    expect(decisionFromVerdict({ ok: true, behavior: { behavior: 'allow' } })).toBe(PermissionBehavior.DENY);
  });
});

// --- isDestructiveCodexTool --------------------------------------------------
describe('isDestructiveCodexTool', () => {
  test('file-edit tools are non-destructive (auto-resume while AFK)', () => {
    expect(isDestructiveCodexTool('apply_patch')).toBe(false);
    expect(isDestructiveCodexTool('Edit')).toBe(false);
    expect(isDestructiveCodexTool('Write')).toBe(false);
    expect(isDestructiveCodexTool('MultiEdit')).toBe(false);
    expect(isDestructiveCodexTool('NotebookEdit')).toBe(false);
  });

  test('a namespaced (MCP) edit tool is still non-destructive', () => {
    expect(isDestructiveCodexTool('myserver__apply_patch')).toBe(false);
  });

  test('shell / exec / network / unknown tools are destructive', () => {
    expect(isDestructiveCodexTool('local_shell')).toBe(true);
    expect(isDestructiveCodexTool('shell')).toBe(true);
    expect(isDestructiveCodexTool('exec')).toBe(true);
    expect(isDestructiveCodexTool('container.exec')).toBe(true);
    expect(isDestructiveCodexTool('some_random_tool')).toBe(true);
  });

  test('missing / empty tool name → destructive (fail-closed)', () => {
    expect(isDestructiveCodexTool(undefined)).toBe(true);
    expect(isDestructiveCodexTool('')).toBe(true);
  });
});

// --- codexMessagedSinceLastPrompt --------------------------------------------
/** Wrap a payload in the rollout envelope Codex writes per line. */
const responseItem = (payload: Record<string, unknown>) => JSON.stringify({ type: 'response_item', timestamp: 't', payload });
const userMsg = (text: string) => responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistantMsg = (text: string) => responseItem({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const fnCall = (name: string, args = '{}') => responseItem({ type: 'function_call', call_id: 'c', name, arguments: args });
const toolOutput = (text: string) => responseItem({ type: 'function_call_output', call_id: 'c', output: text });

describe('codexMessagedSinceLastPrompt', () => {
  test('true when a message_user function_call follows the last user prompt', () => {
    const lines = [userMsg('do the thing'), assistantMsg('working'), fnCall('message_user', '{"text":"done"}')];
    expect(codexMessagedSinceLastPrompt(lines)).toBe(true);
  });

  test('accepts a namespaced message_user (server__ and server.)', () => {
    expect(codexMessagedSinceLastPrompt([userMsg('go'), fnCall('imsg-device__message_user')])).toBe(true);
    expect(codexMessagedSinceLastPrompt([userMsg('go'), fnCall('imsg-device.message_user')])).toBe(true);
  });

  test('false when the agent only emitted assistant text + other tools (no message_user)', () => {
    const lines = [userMsg('do the thing'), fnCall('shell', '{"command":"ls"}'), assistantMsg('here you go')];
    expect(codexMessagedSinceLastPrompt(lines)).toBe(false);
  });

  test('a message_user BEFORE the last user prompt does NOT count (turn boundary)', () => {
    // Reported last turn, then a fresh user prompt arrived and the agent has not
    // reported yet → must be false (the prior report belongs to the prior turn).
    const lines = [
      userMsg('turn one'),
      fnCall('message_user', '{"text":"turn one done"}'),
      userMsg('turn two'),
      assistantMsg('working on turn two'),
    ];
    expect(codexMessagedSinceLastPrompt(lines)).toBe(false);
  });

  test('a tool OUTPUT (function_call_output) is not a turn boundary', () => {
    // A tool result is delivered as a separate rollout line but is NOT a user
    // prompt; a message_user after it (same turn) still counts.
    const lines = [userMsg('go'), fnCall('shell'), toolOutput('ok'), fnCall('message_user')];
    expect(codexMessagedSinceLastPrompt(lines)).toBe(true);
  });

  test('startup-context / developer preamble frames are not turn boundaries', () => {
    // These are dropped by extractCodexActivity, so they never reset the scan; a
    // message_user with no real user prompt in the window is still detected.
    const lines = [
      responseItem({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system rules' }] }),
      responseItem({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context><cwd>/r</cwd></environment_context>' }],
      }),
      fnCall('message_user'),
    ];
    expect(codexMessagedSinceLastPrompt(lines)).toBe(true);
  });

  test('empty input and unparseable lines are handled', () => {
    expect(codexMessagedSinceLastPrompt([])).toBe(false);
    expect(codexMessagedSinceLastPrompt(['{ not json', userMsg('go')])).toBe(false);
    expect(codexMessagedSinceLastPrompt(['{ not json', fnCall('message_user')])).toBe(true);
  });
});
