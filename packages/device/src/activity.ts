/**
 * @imsg/device — transcript → lightweight activity extractor.
 *
 * Ported in spirit from prbe-cc-tap-plugin's tap/sanitize.py, but reshaped: the
 * tap-plugin ships trimmed RAW events; we emit a coarse, typed activity stream
 * that says WHAT a session is doing, never the full data. Per the product
 * decision (AFK tap):
 *   - user text          → USER_MESSAGE { text }
 *   - assistant text     → ASSISTANT_TEXT { text }
 *   - tool_use           → TOOL_USE { toolName, summary }   (one line of the input)
 *   - tool_result        → TOOL_RESULT { isError }  ONLY when it failed
 *   - thinking blocks     → DROPPED entirely (reasoning, not "what it's doing")
 *   - CC bookkeeping / meta / API metadata → DROPPED
 *
 * Every surfaced text/summary is run through the existing secret-redaction
 * (sanitize.ts) before it can leave the machine. Full tool inputs and full tool
 * results are NEVER shipped.
 */
import { ActivityKind } from '@imsg/shared';
import { sanitizeText } from './sanitize.ts';

/** One surfaced unit of activity for a single transcript block. */
export interface ExtractedActivity {
  kind: ActivityKind;
  toolName?: string;
  text?: string;
  summary?: string;
  isError?: boolean;
}

/** Top-level CC event types that carry no conversational content. */
const DROP_EVENT_TYPES = new Set(['file-history-snapshot', 'last-prompt', 'ai-title', 'permission-mode']);

/** `system` subtypes that are pure bookkeeping. */
const DROP_SYSTEM_SUBTYPES = new Set(['stop_hook_summary', 'turn_duration']);

/**
 * When summarizing a tool_use input, the first key with a non-empty string wins
 * (most-identifying first): the Bash command, the file path, the search pattern,
 * the URL/query, else a generic path/description.
 */
const TOOL_SUMMARY_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'path', 'description'] as const;

/** Hard cap on a one-line tool summary (a minified one-liner can't bloat it). */
const TOOL_SUMMARY_MAX_LEN = 200;

function firstLine(s: string): string {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

function summarizeToolInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const obj = input as Record<string, unknown>;
  for (const key of TOOL_SUMMARY_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v) return firstLine(v).slice(0, TOOL_SUMMARY_MAX_LEN);
  }
  return '';
}

/**
 * Extract zero or more activity units from one parsed transcript line. A single
 * line (one message) can yield several blocks (e.g. assistant text + two tool
 * calls); the caller assigns each a stable `blockIdx` = its position here.
 */
export function extractActivity(raw: unknown): ExtractedActivity[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const ev = raw as Record<string, unknown>;

  const type = ev['type'];
  if (typeof type === 'string' && DROP_EVENT_TYPES.has(type)) return [];
  if (type === 'system') {
    const sub = ev['subtype'];
    if (typeof sub === 'string' && DROP_SYSTEM_SUBTYPES.has(sub)) return [];
  }
  // Drop CC-injected meta turns (caveats, system reminders) — not conversation.
  if (ev['isMeta'] === true) return [];

  const msg = ev['message'];
  if (typeof msg !== 'object' || msg === null) return [];
  const m = msg as Record<string, unknown>;
  const role = typeof m['role'] === 'string' ? m['role'] : type;
  const isAssistant = role === 'assistant';
  const textKind = isAssistant ? ActivityKind.ASSISTANT_TEXT : ActivityKind.USER_MESSAGE;

  const out: ExtractedActivity[] = [];
  const content = m['content'];

  // Some user turns store content as a bare string (the typed prompt).
  if (typeof content === 'string') {
    const text = sanitizeText(content);
    if (text.trim()) out.push({ kind: textKind, text });
    return out;
  }
  if (!Array.isArray(content)) return out;

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    switch (b['type']) {
      case 'text': {
        const t = typeof b['text'] === 'string' ? sanitizeText(b['text']) : '';
        if (t.trim()) out.push({ kind: textKind, text: t });
        break;
      }
      case 'tool_use': {
        const toolName = typeof b['name'] === 'string' ? b['name'] : 'tool';
        const summaryRaw = summarizeToolInput(b['input']);
        const entry: ExtractedActivity = { kind: ActivityKind.TOOL_USE, toolName };
        if (summaryRaw) entry.summary = sanitizeText(summaryRaw);
        out.push(entry);
        break;
      }
      case 'tool_result': {
        // Successful results carry no signal beyond the tool_use above; only a
        // FAILED step is worth surfacing (and never its content).
        if (b['is_error'] === true) out.push({ kind: ActivityKind.TOOL_RESULT, isError: true });
        break;
      }
      // thinking + any unknown block type: dropped.
      default:
        break;
    }
  }
  return out;
}
