#!/usr/bin/env bun
/**
 * @imsg/device — Codex PermissionRequest hook: approve-and-resume.
 *
 * Codex has NO native permission-relay channel (unlike Claude Code's Channels
 * claude/channel/permission), so the AFK approval loop is implemented as a
 * BLOCKING PermissionRequest hook: while AFK, a destructive tool's approval is
 * forwarded to the control plane, which long-polls the user's tap-back verdict
 * and returns {behavior}; the hook blocks on that response and emits the verdict
 * as Codex's PermissionRequest decision. This is the Codex analog of the CC
 * channel server relaying a permission prompt to the phone.
 *
 * Behavior matrix (the pure parts live in src/codex-hooks.ts, unit-tested):
 *   - AFK OFF                        → exit 0 (no decision) → Codex's native local
 *                                      approval prompt handles it at the keyboard.
 *   - AFK ON + non-destructive tool  → allow (file edits are safe to auto-resume
 *                                      while remote; mirrors safety.isDestructiveTool).
 *   - AFK ON + destructive tool      → POST controlPlaneUrl + DeviceApiRoute.PERMISSION
 *                                      {sessionId, toolName, summary}; BLOCK on the
 *                                      long-poll; emit decisionFromVerdict(response).
 *   - ANY error / non-200 / unpaired → deny (fail-CLOSED; never silently allow).
 *
 * The killswitch invariant holds: egress failures must NEVER turn a deny into an
 * allow — the ONLY path to allow is an explicit, well-formed `allow` verdict (or
 * a non-destructive tool). hooks/codex/hooks.json sets a generous `timeout` on
 * this hook (3600s) so the long-poll has room; the control-plane deadline must be
 * SHORTER than that timeout so a timeout is a clean deny, not a fall-through to
 * the unattended local prompt.
 */
import { writeSync } from 'node:fs';
import { AfkState, DeviceApiRoute, MESSAGE_USER_TOOL } from '@imsg/shared';
import {
  controlPlaneUrl,
  migrateLegacyDeviceDir,
  pickEagerSessionId,
} from '../../src/config.ts';
import { readHandshakeForProject } from '../../src/handshake.ts';
import { loadToken } from '../../src/creds.ts';
import { Classification, parseJson, postJson } from '../../src/httpclient.ts';
import { readAfk } from '../../src/state.ts';
import {
  PermissionBehavior,
  decisionFromVerdict,
  isDestructiveCodexTool,
} from '../../src/codex-hooks.ts';

const PERMISSION_REQUEST = 'PermissionRequest';

/** Hook block timeout for the control-plane long-poll. MUST be < the `timeout`
 *  set on this hook in hooks/codex/hooks.json (3600s) and the server-side
 *  deadline MUST be shorter still, so a server timeout returns an explicit deny
 *  before this client gives up. 1h covers a user who is away for a while. */
const PERMISSION_POLL_TIMEOUT_MS = 60 * 60 * 1_000;

/** Emit a PermissionRequest decision and exit. writeSync so the decision is on
 *  fd 1 before exit — a dropped allow/deny would fall through to a TTY-less prompt. */
function emit(behavior: PermissionBehavior): never {
  writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: { hookEventName: PERMISSION_REQUEST, decision: { behavior } },
    }),
  );
  process.exit(0);
}

/** Allow the tool to proceed with NO decision — Codex falls back to its native
 *  local approval prompt (only safe at the keyboard, i.e. AFK off). */
function passToNative(): never {
  process.exit(0);
}

/** One-line, most-identifying summary of a tool input for the phone notification
 *  (command > file_path > pattern > url > query > path > description), capped.
 *  Never ships the full input. tool_input arrives as an object on Codex's
 *  PreToolUse/PermissionRequest stdin. */
const SUMMARY_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'path', 'description'] as const;
function summarize(toolInput: unknown): string {
  if (typeof toolInput !== 'object' || toolInput === null) return '';
  const obj = toolInput as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v) {
      const nl = v.indexOf('\n');
      return (nl === -1 ? v : v.slice(0, nl)).slice(0, 200);
    }
    // Codex local_shell passes the command as an array under `command`.
    if (key === 'command' && Array.isArray(v) && v.length > 0) {
      return v.map((t) => String(t)).join(' ').slice(0, 200);
    }
  }
  return '';
}

// Relocate pre-0.1.7 state into ~/.imsg before reading afk.state.
migrateLegacyDeviceDir();

const raw = await Bun.stdin.text();
let input: Record<string, unknown> = {};
try {
  input = JSON.parse(raw) as Record<string, unknown>;
} catch {
  /* malformed hook input — fail closed below if AFK, else pass to native */
}

const afk = readAfk() === AfkState.ON;
const toolName = String(input['tool_name'] ?? input['toolName'] ?? '');

// At the keyboard → native local approval (no relay, no decision).
if (!afk) passToNative();

// AFK + a safe (file-edit) tool → auto-resume; no need to wake the user.
if (!isDestructiveCodexTool(toolName)) emit(PermissionBehavior.ALLOW);

// AFK + destructive: never auto-allow message_user (it's the relay tool itself,
// already pre-allowed elsewhere; defensively allow so we never deadlock the
// approval channel on our own tool).
if (toolName === MESSAGE_USER_TOOL || toolName.endsWith(`__${MESSAGE_USER_TOOL}`)) {
  emit(PermissionBehavior.ALLOW);
}

// AFK + destructive → forward to the control plane and BLOCK on the verdict.
const token = loadToken();
if (!token) emit(PermissionBehavior.DENY); // unpaired → fail closed

const sessionId =
  pickEagerSessionId() ??
  readHandshakeForProject(
    (process.env.CLAUDE_PROJECT_DIR && process.env.CLAUDE_PROJECT_DIR.trim()) ||
      String(input['cwd'] ?? '') ||
      process.cwd(),
  )?.sessionId ??
  (typeof input['session_id'] === 'string' ? input['session_id'] : '');

if (!sessionId) emit(PermissionBehavior.DENY); // can't bind a verdict → fail closed

try {
  const resp = await postJson(
    controlPlaneUrl() + DeviceApiRoute.PERMISSION,
    JSON.stringify({ sessionId, toolName, summary: summarize(input['tool_input'] ?? input['toolInput']) }),
    { bearer: token, timeoutMs: PERMISSION_POLL_TIMEOUT_MS },
  );
  if (resp.classification !== Classification.SUCCESS) emit(PermissionBehavior.DENY);
  const body = parseJson<{ behavior?: unknown }>(resp);
  emit(decisionFromVerdict({ ok: true, behavior: body?.behavior }));
} catch {
  emit(PermissionBehavior.DENY); // any error → fail closed
}
