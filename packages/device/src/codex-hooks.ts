/**
 * @imsg/device — Codex hook decision core (pure, testable).
 *
 * The Codex CLI counterpart to the decision logic embedded in the Claude Code
 * hooks (hooks/state-hook.ts Stop gate, hooks/intercept.ts permission routing).
 * Codex has NO native permission-relay channel and NO SessionEnd, so the AFK
 * gates are implemented as Codex hooks (hooks/codex/*) that shell out to bun;
 * the *decisions* those hooks make are extracted HERE so they can be unit-tested
 * without a live `codex` process.
 *
 * Three concerns, each a pure function:
 *   1. {@link shouldBlockStop}        — the AFK Stop gate (block turn-end until the
 *                                        agent reaches the user via message_user).
 *   2. {@link isDestructiveCodexTool} — does a Codex tool need approve-and-resume?
 *   3. {@link decisionFromVerdict}    — map a control-plane verdict (or an error)
 *                                        to a PermissionRequest behavior, fail-CLOSED.
 *
 * Plus the Codex-rollout analog of transcript.ts's turn-scoped "did the agent
 * report this turn?" scan ({@link codexMessagedSinceLastPrompt}) — the rollout is
 * the only place a Codex Stop hook can see whether message_user was called.
 */
import { statSync } from 'node:fs';
import { ActivityKind, MESSAGE_USER_TOOL } from '@imsg/shared';
import { readNew } from './transcript.ts';
import { extractCodexActivity } from './transcript-codex.ts';

// -----------------------------------------------------------------------------
// 1. Turn-scoped "did the agent call message_user this turn?" — Codex rollout.
//
// The Codex analog of transcript.ts's agentMessagedSinceLastPrompt. The turn
// boundary is the last REAL user message (a response_item.message role=user that
// is NOT a startup-context/developer preamble frame and NOT a tool output);
// message_user appears as a response_item.function_call named `message_user`
// (bare) or `<server>__message_user` / `<server>.message_user` (namespaced) —
// accept all three, mirroring the CC scan's bare + `__message_user` matching.
// -----------------------------------------------------------------------------

/** True iff a parsed rollout line is a `message_user` MCP function_call. */
function isMessageUserCall(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const ev = parsed as Record<string, unknown>;
  if (ev['type'] !== 'response_item') return false;
  const payload = ev['payload'];
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  // Codex MCP tools surface as a function_call (custom_tool_call is the
  // freeform-tool variant); a name match on either is the agent reaching out.
  if (p['type'] !== 'function_call' && p['type'] !== 'custom_tool_call') return false;
  const name = typeof p['name'] === 'string' ? p['name'] : '';
  return (
    name === MESSAGE_USER_TOOL ||
    name.endsWith(`__${MESSAGE_USER_TOOL}`) ||
    name.endsWith(`.${MESSAGE_USER_TOOL}`)
  );
}

/**
 * True iff a parsed rollout line is a REAL user prompt (the turn boundary) —
 * NOT a tool output, NOT a developer/startup-context preamble frame. We reuse
 * {@link extractCodexActivity}, which already drops developer + startup frames
 * and tool outputs: a line that yields a USER_MESSAGE activity is, by exactly
 * that definition, a real user prompt.
 */
function isRealCodexUserPrompt(parsed: unknown): boolean {
  for (const a of extractCodexActivity(parsed)) {
    if (a.kind === ActivityKind.USER_MESSAGE && a.text && a.text.trim()) return true;
  }
  return false;
}

/**
 * Pure scan: did the agent call message_user since the last real user prompt in
 * a Codex rollout? Walks BACKWARD (newest first) and short-circuits — returns
 * true the moment a message_user call is seen, false once the turn boundary (the
 * last real user prompt) is crossed first. Unparseable lines are skipped. The
 * direct analog of transcript.ts's agentMessagedSinceLastPrompt. Unit-tested.
 */
export function codexMessagedSinceLastPrompt(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // partial/corrupt line — ignore
    }
    if (isMessageUserCall(parsed)) return true;
    if (isRealCodexUserPrompt(parsed)) return false;
  }
  return false;
}

/** Cap on the rollout tail scanned at turn-end — mirrors transcript.ts's
 *  MAX_TURN_SCAN_BYTES. One turn is tiny; this bounds the Stop-hook read on a
 *  long session whose rollout may be many MB. */
const MAX_TURN_SCAN_BYTES = 4 * 1024 * 1024;

/**
 * fs wrapper around {@link codexMessagedSinceLastPrompt}: reads at most the last
 * MAX_TURN_SCAN_BYTES of the rollout via {@link readNew} (reusing the tested
 * byte-offset split/CRLF handling) and scans it. When the window starts mid-file
 * its first line is partial — that's malformed JSON the scan skips, so no special
 * trimming is needed. Defaults to FALSE on any read error — failing toward
 * "nudge the agent to report", which the Stop gate bounds to one nudge. The
 * Codex analog of transcript.ts's messagedUserThisTurn (impure thin layer).
 */
export function codexMessagedUserThisTurn(transcriptPath: string): boolean {
  try {
    const size = statSync(transcriptPath).size;
    const start = size > MAX_TURN_SCAN_BYTES ? size - MAX_TURN_SCAN_BYTES : 0;
    const { lines } = readNew(transcriptPath, start);
    return codexMessagedSinceLastPrompt(lines);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// 2. AFK Stop gate — the pure decision (mirrors state-hook.ts's Stop branch).
// -----------------------------------------------------------------------------

/** Inputs to the Stop-gate decision (all injected so the function is pure). */
export interface StopGateInput {
  /** AFK on? (read from afk.state). Off → never block. */
  afk: boolean;
  /** Codex's `stop_hook_active` — true means we already blocked once this turn. */
  stopHookActive: boolean;
  /** Did the agent call message_user since the last user prompt this turn? */
  messagedThisTurn: boolean;
}

/**
 * Should the Stop hook BLOCK turn-end and reprompt the agent to report?
 *
 * Block iff AFK is ON and the agent has NOT reached the user this turn and we
 * have not already blocked once (self-limit). This is the symmetric counterpart
 * to intercept.ts denying AskUserQuestion, ported to Codex's blocking Stop hook.
 *
 * Self-limit is critical: Codex has NO system loop cap on a blocking Stop hook
 * (unlike Claude Code's 8-block ceiling), so a forever-blocking gate would wedge
 * the session. We release after exactly ONE nudge — either the agent reported
 * (messagedThisTurn) OR Codex re-ran us with stop_hook_active=true (our prior
 * block). One forced nudge is the bounded trade-off, identical to the CC gate.
 *
 * Pure + total; every branch is covered by a unit test.
 */
export function shouldBlockStop(input: StopGateInput): boolean {
  if (!input.afk) return false; // at the keyboard → never gate
  if (input.stopHookActive) return false; // already nudged once → don't loop
  return !input.messagedThisTurn; // not reported yet → block once
}

// -----------------------------------------------------------------------------
// 3. is-destructive — which Codex tools need approve-and-resume while AFK.
//
// Mirrors the control plane's safety.isDestructiveTool notion (file edits are
// safe; everything else — shell/exec/network/unknown — is destructive) but for
// CODEX tool names. Codex's edit surface is the `apply_patch` function tool (its
// file-write primitive); shell/exec is `local_shell` / `shell` / `exec` /
// container.exec. Conservative & fail-CLOSED: an unknown tool is destructive.
// -----------------------------------------------------------------------------

/**
 * Codex's NON-destructive (always-safe-to-auto-resume) tools: the file-edit
 * surface. Codex applies edits via `apply_patch`; the CC edit tool names are
 * accepted too in case a plugin exposes them under those names. A namespaced MCP
 * variant (`<server>__apply_patch`) also counts (suffix-matched below).
 */
const CODEX_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'apply_patch',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

/**
 * Is a Codex permission for `toolName` destructive (i.e. while AFK it must be
 * routed to the phone for approve-and-resume rather than auto-resumed)?
 * Conservative & fail-closed: missing/unknown → destructive; file-edit tools →
 * non-destructive; everything else (local_shell, exec, …) → destructive. Pure.
 */
export function isDestructiveCodexTool(toolName: string | undefined): boolean {
  if (!toolName) return true; // unknown → destructive
  if (CODEX_EDIT_TOOLS.has(toolName)) return false;
  // Accept an MCP-namespaced edit tool (`<server>__apply_patch`).
  for (const safe of CODEX_EDIT_TOOLS) {
    if (toolName.endsWith(`__${safe}`)) return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// 4. verdict → PermissionRequest decision — fail-CLOSED.
//
// Codex's PermissionRequest hook returns {behavior: allow|deny}. The control
// plane long-polls the user's tap-back and returns {behavior}. We map that to a
// decision — but ANYTHING ambiguous (HTTP error, non-200, malformed body,
// missing/garbage behavior) maps to DENY. Egress/killswitch failures must NEVER
// turn a deny into an allow (the killswitch invariant), so the only path to
// `allow` is an explicit, well-formed `allow` verdict.
// -----------------------------------------------------------------------------

export const PermissionBehavior = {
  ALLOW: 'allow',
  DENY: 'deny',
} as const;
export type PermissionBehavior = (typeof PermissionBehavior)[keyof typeof PermissionBehavior];

/** The shape the control plane returns from POST /api/device/permission. */
export interface PermissionVerdict {
  /** Whether the control plane reached the user and got a verdict at all. */
  ok: boolean;
  /** The user's verdict, when ok. Any non-`allow` value (incl. undefined) → deny. */
  behavior?: unknown;
}

/**
 * Map a control-plane verdict (or a failed call) to the PermissionRequest
 * behavior. Fail-CLOSED: only an `ok` result carrying exactly `behavior:"allow"`
 * yields ALLOW; every other input — not ok, missing behavior, `"deny"`, or any
 * garbage — yields DENY. Pure + total; unit-tested across all branches.
 */
export function decisionFromVerdict(verdict: PermissionVerdict): PermissionBehavior {
  if (!verdict.ok) return PermissionBehavior.DENY;
  return verdict.behavior === PermissionBehavior.ALLOW
    ? PermissionBehavior.ALLOW
    : PermissionBehavior.DENY;
}
