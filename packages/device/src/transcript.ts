/**
 * @imsg/device — Claude Code transcript tailer (byte-offset cursor).
 *
 * Ported from an internal Claude Code tap plugin's transcript reader. We track BYTES (not line
 * counts) so a partial trailing line — written mid-flush by Claude Code — does
 * not advance the cursor and gets re-read next tick once the newline lands.
 *
 * Truncation/rotation is detected by comparing the file size to the persisted
 * cursor: if the file shrank below the offset we reset to 0.
 *
 * `splitLines` is pure (unit-tested directly); `readNew` is the thin fs layer.
 *
 * This module also hosts the turn-scoped scan the AFK Stop gate relies on
 * ({@link agentMessagedSinceLastPrompt} / {@link messagedUserThisTurn}): "since
 * the last real user prompt, did the agent call message_user?". The pure scan is
 * unit-tested directly; the fs wrapper is the thin layer.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { MESSAGE_USER_TOOL } from '@imsg/shared';

const LF = 0x0a; // '\n'
const CR = 0x0d; // '\r'

export interface TailResult {
  /** Complete (newline-terminated) lines as UTF-8 strings, blanks skipped. */
  lines: string[];
  /** Cursor to persist: bytes consumed (excludes any partial trailing line). */
  newByteOffset: number;
  /** Current file size (for truncation detection next tick). */
  fileSize: number;
}

/**
 * Split a buffer into newline-terminated lines. Returns the complete lines
 * (blank lines skipped, a trailing '\r' stripped) and the count of trailing
 * PARTIAL bytes (an unterminated final line). The caller must subtract `partial`
 * from the new cursor so those bytes are re-read once the writer flushes '\n'.
 */
export function splitLines(buf: Buffer): { lines: string[]; partial: number } {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === LF) {
      let end = i;
      if (end > start && buf[end - 1] === CR) end -= 1; // strip CRLF
      if (end > start) lines.push(buf.toString('utf8', start, end)); // skip blanks
      start = i + 1;
    }
  }
  return { lines, partial: buf.length - start };
}

/**
 * Read bytes from `byteOffset` to EOF and return the complete lines. If the file
 * has shrunk below the offset (truncation/rotation), reset to 0.
 */
export function readNew(path: string, byteOffset: number): TailResult {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    let start = byteOffset;
    if (size < byteOffset) start = 0; // truncated/rotated → re-read from the top
    if (size <= start) return { lines: [], newByteOffset: start, fileSize: size };

    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const slice = read === length ? buf : buf.subarray(0, read);
    const { lines, partial } = splitLines(slice);
    return { lines, newByteOffset: start + (slice.length - partial), fileSize: size };
  } finally {
    closeSync(fd);
  }
}

// -----------------------------------------------------------------------------
// Turn-scoped "did the agent report this turn?" scan — used by the AFK Stop gate
// (hooks/state-hook.ts). The boundary of "this turn" is the last REAL user
// prompt; tool_results are delivered as user-role messages but are NOT prompts.
// Sidechain (Task subagent) lines are ignored throughout: a subagent's prompt is
// not the user's prompt, and a subagent calling message_user is not the MAIN
// agent reporting — only the main agent's turn-end is gated.
// -----------------------------------------------------------------------------

/** A main-agent assistant line whose message contains a `message_user` tool_use. */
function isMessageUserToolUse(ev: Record<string, unknown>): boolean {
  if (ev['isSidechain'] === true) return false; // a subagent's call, not the main agent's
  const msg = ev['message'];
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m['role'] !== 'assistant') return false;
  const content = m['content'];
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] !== 'tool_use') continue;
    const name = typeof b['name'] === 'string' ? b['name'] : '';
    // Bare in this package's own MCP server; fully-qualified (mcp__<server>__…)
    // in a real Claude Code transcript — accept both.
    if (name === MESSAGE_USER_TOOL || name.endsWith(`__${MESSAGE_USER_TOOL}`)) return true;
  }
  return false;
}

/**
 * A REAL user prompt (the turn boundary) — NOT a tool_result, which Claude Code
 * also delivers as a user-role message. A typed prompt is either a bare string
 * or a content array carrying at least one block that is NOT a tool_result (text,
 * image, …); a tool_result message carries only `tool_result` blocks. CC-injected
 * meta turns and sidechain (subagent) prompts are excluded.
 */
function isRealUserPrompt(ev: Record<string, unknown>): boolean {
  if (ev['isMeta'] === true || ev['isSidechain'] === true) return false;
  const msg = ev['message'];
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  const role = typeof m['role'] === 'string' ? m['role'] : ev['type'];
  if (role !== 'user') return false;
  const content = m['content'];
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(
      (b) =>
        typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] !== 'tool_result',
    );
  }
  return false;
}

/**
 * Pure scan: did the agent call message_user since the last real user prompt?
 * Walks the lines BACKWARD (newest first) and short-circuits — returns true the
 * moment a message_user tool_use is seen, false once the turn boundary (the last
 * real user prompt) is crossed first. Unparseable lines are skipped. Unit-tested.
 */
export function agentMessagedSinceLastPrompt(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // partial/corrupt line — ignore
    }
    if (isMessageUserToolUse(ev)) return true;
    if (isRealUserPrompt(ev)) return false;
  }
  return false;
}

/** Cap on the transcript tail scanned at turn-end. One turn is tiny; this bounds
 *  the Stop-hook read (which sits in the turn-end path) on a long-running session
 *  whose transcript may be many MB. */
const MAX_TURN_SCAN_BYTES = 4 * 1024 * 1024;

/**
 * fs wrapper around {@link agentMessagedSinceLastPrompt}: reads at most the last
 * MAX_TURN_SCAN_BYTES of the transcript via {@link readNew} (which reuses the
 * tested split/CRLF handling) and scans it. When the window starts mid-file its
 * first line is partial — that is malformed JSON and the scan skips it, so no
 * special trimming is needed. Defaults to FALSE on any read error — failing
 * toward "nudge the agent to report", which the Stop gate bounds to one nudge.
 */
export function messagedUserThisTurn(transcriptPath: string): boolean {
  try {
    const size = statSync(transcriptPath).size;
    const start = size > MAX_TURN_SCAN_BYTES ? size - MAX_TURN_SCAN_BYTES : 0;
    const { lines } = readNew(transcriptPath, start);
    return agentMessagedSinceLastPrompt(lines);
  } catch {
    return false;
  }
}
