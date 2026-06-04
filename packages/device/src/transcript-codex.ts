/**
 * @imsg/device — Codex rollout → lightweight activity extractor.
 *
 * The Codex CLI counterpart to {@link ./activity.ts}'s CC reducer. Codex writes
 * a rollout JSONL where each line is a `RolloutItem`:
 *   {"type": <variant>, "payload": {...}, "timestamp": "..."}
 * with variant ∈ {session_meta, turn_context, response_item, event_msg, …}.
 *
 * Ported in spirit from an internal Codex tap plugin's sanitizer — but that
 * plugin shim-translates each line into the full Claude-Code transcript shape;
 * we instead emit THIS repo's coarse, typed {@link ExtractedActivity} stream
 * (the SAME shape `extractActivity` produces), so the activity tap can treat a
 * Codex session exactly like a CC one. Per the AFK-tap product decision:
 *   - user text (non-startup-context) → USER_MESSAGE { text }
 *   - assistant text                  → ASSISTANT_TEXT { text }
 *   - function_call / local_shell_call / custom_tool_call
 *                                      → TOOL_USE { toolName, summary }  (one line of the input)
 *   - *_output                         → TOOL_RESULT { isError }  ONLY when it failed
 *   - reasoning                        → DROPPED (the CC reducer drops thinking too)
 *   - developer-role / startup-context frames → DROPPED
 *   - session_meta / turn_context / event_msg/* / token_count → DROPPED (metadata + UI mirror + noise)
 *
 * Every surfaced text/summary is run through the existing secret-redaction
 * (sanitize.ts) before it can leave the machine — full tool inputs and full
 * tool results are NEVER shipped, matching the CC path exactly.
 */
import { ActivityKind } from '@imsg/shared';
import { sanitizeText } from './sanitize.ts';
import type { ExtractedActivity } from './activity.ts';

/**
 * When summarizing a tool input, the first key with a non-empty string wins
 * (most-identifying first): the shell command, the file path, the search
 * pattern, the URL/query, else a generic path/description. Mirrors the CC
 * reducer's `TOOL_SUMMARY_KEYS` so a Codex tool marker reads like a CC one.
 */
const TOOL_SUMMARY_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'path', 'description'] as const;

/** Hard cap on a one-line tool summary (a minified one-liner can't bloat it). */
const TOOL_SUMMARY_MAX_LEN = 200;

/**
 * Codex wraps the session preamble (sandbox rules, skills/plugins lists, the
 * environment dump) in these XML-tagged user/developer frames. A message whose
 * every text block is one of these is pure startup context, not conversation —
 * dropped, matching sanitize.py's `_STARTUP_CONTEXT_TAGS`.
 */
const STARTUP_CONTEXT_TAGS = [
  'permissions instructions',
  'skills_instructions',
  'plugins_instructions',
  'environment_context',
] as const;

function firstLine(s: string): string {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

/**
 * One-line summary of a tool input, capped at {@link TOOL_SUMMARY_MAX_LEN}.
 * A `function_call`'s `arguments` is a raw JSON string per Codex's protocol, so
 * we parse it first; a `custom_tool_call`'s `input` and a `local_shell_call`'s
 * `action` arrive as objects already. Once we hold an object, the key-priority
 * scan mirrors the CC reducer's `summarizeToolInput`.
 */
function summarizeToolInput(input: unknown): string {
  let value = input;
  if (typeof value === 'string') {
    const str = value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(str);
    } catch {
      // Not JSON — fall back to the first line of the raw string.
      return firstLine(str).slice(0, TOOL_SUMMARY_MAX_LEN);
    }
    // A non-object JSON scalar carries no identifying key — use the raw first line.
    if (typeof parsed !== 'object' || parsed === null) return firstLine(str).slice(0, TOOL_SUMMARY_MAX_LEN);
    value = parsed;
  }
  if (typeof value !== 'object' || value === null) return '';
  const obj = value as Record<string, unknown>;
  for (const key of TOOL_SUMMARY_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v) return firstLine(v).slice(0, TOOL_SUMMARY_MAX_LEN);
  }
  return '';
}

/** The text of every `input_text`/`output_text` block in a message's content. */
function contentTexts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    if (c['type'] !== 'input_text' && c['type'] !== 'output_text') continue;
    if (typeof c['text'] === 'string' && c['text']) texts.push(c['text']);
  }
  return texts;
}

/** True for a `<environment_context>…</environment_context>`-style preamble frame. */
function isStartupContextText(text: string): boolean {
  const stripped = text.trim().toLowerCase();
  return STARTUP_CONTEXT_TAGS.some(
    (tag) => stripped.startsWith(`<${tag}>`) && stripped.endsWith(`</${tag}>`),
  );
}

/** True when a user message is ENTIRELY startup context (every text block a frame). */
function isStartupContextMessage(content: unknown): boolean {
  const texts = contentTexts(content);
  return texts.length > 0 && texts.every(isStartupContextText);
}

/** True for Codex's injected AGENTS.md project-instructions frame — the AGENTS.md
 *  file dumped in as a user turn (`# AGENTS.md instructions for <dir>`). It's pure
 *  context, never a real prompt, so it must not surface as a user message nor
 *  become the session title. */
function isAgentsInstructions(text: string): boolean {
  return text.trimStart().startsWith('# AGENTS.md instructions for ');
}

/** When a user turn carries attached-files or in-app-browser context, Codex
 *  prepends that context and delimits the user's real prompt with this marker on
 *  its OWN line. Strip everything up to and including the marker line so we
 *  surface the prompt, not the wrapper. Returns the original text unchanged when
 *  the marker is absent (no wrapper), is not on its own line (a real prompt that
 *  merely quotes the string), or has an empty body (attachment-only turn) — so a
 *  real turn is never reduced to nothing. The LAST marker line wins (a nested
 *  wrapper). */
const CODEX_REQUEST_MARKER = '## My request for Codex:';
function unwrapCodexRequest(text: string): string {
  const lines = text.split('\n');
  let marker = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i]!.trim() === CODEX_REQUEST_MARKER) marker = i;
  if (marker === -1) return text;
  const body = lines.slice(marker + 1).join('\n').trim();
  return body || text;
}

/** A `local_shell_call`'s `action.command` (array or string) → a one-line summary. */
function summarizeShellAction(action: unknown): string {
  if (typeof action !== 'object' || action === null) return '';
  const cmd = (action as Record<string, unknown>)['command'];
  if (Array.isArray(cmd) && cmd.length > 0) {
    return cmd.map((t) => String(t)).join(' ').slice(0, TOOL_SUMMARY_MAX_LEN);
  }
  if (typeof cmd === 'string') return firstLine(cmd).slice(0, TOOL_SUMMARY_MAX_LEN);
  return '';
}

/**
 * Codex's `FunctionCallOutputPayload` is either a string or a dict carrying an
 * `is_error` flag — we only surface a failed step (the CC reducer drops every
 * successful tool result the same way).
 */
function outputIsError(output: unknown): boolean {
  return typeof output === 'object' && output !== null && Boolean((output as Record<string, unknown>)['is_error']);
}

/** Emit a TOOL_USE marker for a named tool call with an optional one-line summary. */
function toolUseActivity(toolName: string, summaryRaw: string): ExtractedActivity {
  const entry: ExtractedActivity = { kind: ActivityKind.TOOL_USE, toolName };
  if (summaryRaw) entry.summary = sanitizeText(summaryRaw);
  return entry;
}

/** A `response_item.message` → zero or more text activities (injected-context
 *  frames dropped, attached-files/browser turns unwrapped to the real prompt). */
function extractMessage(payload: Record<string, unknown>): ExtractedActivity[] {
  const role = typeof payload['role'] === 'string' ? payload['role'] : 'user';
  // Developer instructions are pure system framing; startup-context user frames
  // (sandbox/skills/env preamble) carry no conversational signal — both dropped.
  if (role === 'developer') return [];
  if (role === 'user' && isStartupContextMessage(payload['content'])) return [];

  const kind = role === 'assistant' ? ActivityKind.ASSISTANT_TEXT : ActivityKind.USER_MESSAGE;
  const isUser = kind === ActivityKind.USER_MESSAGE;
  const out: ExtractedActivity[] = [];
  for (const raw of contentTexts(payload['content'])) {
    // The AGENTS.md project-instructions frame is pure injected context with no
    // prompt — drop it so it can't become the "first user message" (the session
    // title). An attached-files / in-app-browser turn prepends context and
    // delimits the real prompt with a marker — unwrap back to that prompt.
    if (isUser && isAgentsInstructions(raw)) continue;
    const t = sanitizeText(isUser ? unwrapCodexRequest(raw) : raw);
    if (t.trim()) out.push({ kind, text: t });
  }
  return out;
}

/**
 * Extract zero or more activity units from one parsed Codex rollout line. The
 * Codex analog of {@link extractActivity}: same {@link ExtractedActivity} output
 * contract, so the caller's `buildEvents` assigns each a stable `blockIdx` = its
 * position here. A single `response_item` carries exactly one logical block
 * (Codex splits message/tool_call/reasoning across separate lines), but a multi
 * text-block message can still yield several activities.
 */
export function extractCodexActivity(raw: unknown): ExtractedActivity[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const ev = raw as Record<string, unknown>;

  // Only response_items carry conversation. session_meta / turn_context /
  // event_msg/* (incl. token_count + the agent_message/user_message UI mirror of
  // response_item.message, which is canonical) are metadata/noise — dropped.
  if (ev['type'] !== 'response_item') return [];
  const rawPayload = ev['payload'];
  if (typeof rawPayload !== 'object' || rawPayload === null) return [];
  const payload = rawPayload as Record<string, unknown>;

  switch (payload['type']) {
    case 'message':
      return extractMessage(payload);
    case 'function_call': {
      const toolName = typeof payload['name'] === 'string' ? payload['name'] : 'tool';
      return [toolUseActivity(toolName, summarizeToolInput(payload['arguments']))];
    }
    case 'custom_tool_call': {
      const toolName = typeof payload['name'] === 'string' ? payload['name'] : 'custom_tool';
      return [toolUseActivity(toolName, summarizeToolInput(payload['input']))];
    }
    case 'local_shell_call':
      return [toolUseActivity('local_shell', summarizeShellAction(payload['action']))];
    case 'function_call_output':
    case 'custom_tool_call_output':
      // Successful results carry no signal beyond the tool_use above; only a
      // FAILED step is worth surfacing (and never its content) — as the CC path.
      return outputIsError(payload['output']) ? [{ kind: ActivityKind.TOOL_RESULT, isError: true }] : [];
    // reasoning + any unknown response_item type: dropped (the CC reducer drops
    // thinking blocks too — reasoning is not "what it's doing").
    default:
      return [];
  }
}

/**
 * The first real user message in a Codex rollout — the Codex analog of the CC
 * tap's provisional first-message title seed (tap.ts `scanForTitle`, which takes
 * the first USER_MESSAGE that `extractActivity` yields). Walks lines FORWARD,
 * reuses {@link extractCodexActivity} so developer / startup-context / AGENTS.md
 * frames are filtered and attached-files/browser turns are unwrapped to the real
 * prompt, and returns the first surfaced user text (sanitized), or null. Pure;
 * unparseable lines are skipped. Signature mirrors the pure scans in transcript.ts.
 */
export function firstCodexUserMessage(lines: string[]): string | null {
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // partial/corrupt line — ignore
    }
    for (const a of extractCodexActivity(parsed)) {
      if (a.kind === ActivityKind.USER_MESSAGE && a.text && a.text.trim()) return a.text;
    }
  }
  return null;
}
