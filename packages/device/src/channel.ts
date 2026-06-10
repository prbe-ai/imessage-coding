#!/usr/bin/env bun
/**
 * @imsg/device — channel MCP server (productized from the validated spike).
 *
 * Implements the official Claude Code Channels contract
 * (code.claude.com/docs/en/channels-reference), reusing the spike's working
 * server VERBATIM where possible:
 *   - capability claude/channel              → push events INTO the session
 *   - capability claude/channel/permission   → relay permission prompts OUT
 *   - a `message_user` tool                  → chat bridge OUT (Claude → user)
 *
 * CHANGE FROM THE SPIKE (per the DEVICE PLUGIN contract): the localhost :8799
 * control surface is GONE. Instead this server talks to the CLOUD CONTROL PLANE:
 *   - a permission_request, or message_user(expect_reply) → an AttentionEvent
 *     enqueued in the durable outbox + POSTed to /api/device/attention; a plain
 *     message_user status is POSTed to /api/device/message (Bearer device_token).
 *   - verdicts + answers arrive over the SSE stream GET /api/device/events; a
 *     verdict is relayed back to Claude Code via the claude/channel/permission
 *     notification, and an answer is pushed into the session as a <channel>
 *     message. After injecting, the device POSTs /api/device/ack so the server
 *     marks those decisions delivered and never re-serves them (at-least-once +
 *     in-process dedup).
 *   - afk is mirrored DOWN from the control plane into the local afk.state file
 *     (set from the dashboard or the CLI's POST /api/device/state) so the hook
 *     picks it up; the device does not push afk up on the heartbeat.
 *
 * Auth = Bearer device_token from keychain (file fallback). Egress is gated by
 * the fail-OPEN killswitch. The APPROVAL path is fail-CLOSED: with no decision,
 * NO verdict is sent — Claude Code's own prompt stays the only authority.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  AgentKind,
  AttentionKind,
  ChannelMethod,
  DeviceApiRoute,
  MESSAGE_USER_TOOL,
  RENAME_SESSION_TOOL,
  SESSION_TITLE_MAX_LEN,
  SseEvent,
  type AttentionEvent,
  type InboxItem,
  cleanSessionTitle,
  isAfkState,
} from '@imsg/shared';
import {
  HEARTBEAT_INTERVAL_MS,
  agentKind,
  codexAppServerUrl,
  deviceApiUrl,
  deviceIdFile,
  isPluginHousekeepingDir,
  logDir,
  migrateLegacyDeviceDir,
  pickEagerSessionId,
  sessionTitleFile,
  sessionTitleSentFile,
} from './config.ts';
import { deriveCodexSessionId } from './codex-session.ts';
import { injectReply, resolveActiveThreadId } from './codex-appserver.ts';
import { loadToken } from './creds.ts';
import { readHandshakeForProject } from './handshake.ts';
import { Classification, postJson } from './httpclient.ts';
import { HaltError, drain, enqueue } from './outbox.ts';
import { egressEnabled } from './killswitch.ts';
import { sanitizeOptional, sanitizeText } from './sanitize.ts';
import { readAfk, readAfkDirty, writeAfk, writeAfkDirty, writePending } from './state.ts';
import { shouldAdoptDownstreamAfk, shouldClearDirty } from './afk-sync.ts';
import { messageUserBlockedWhenAfkOff } from './afk-gate.ts';
import { reconcileCaffeinate } from './caffeinate.ts';

// Relocate pre-0.1.7 state from ~/.claude/plugins/imsg-device → ~/.imsg (once).
migrateLegacyDeviceDir();

// --- logging (stderr + file; never the token) -------------------------------
mkdirSync(logDir(), { recursive: true });
const CHAN_LOG = join(logDir(), 'channel.log');
function log(event: string, data: unknown): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, data });
  try {
    appendFileSync(CHAN_LOG, line + '\n');
  } catch {
    /* logging is best-effort */
  }
  process.stderr.write(`[imsg-device] ${line}\n`);
}

// Each channel server instance owns one CC session. Claude Code ≥2.1.160 hands
// the real session id to a plugin's stdio MCP server directly as the
// CLAUDE_CODE_SESSION_ID env var (verified live), so we read it from there — this
// is what lets concurrent sessions in the SAME project dir be told apart, since
// each MCP server now knows its OWN id instead of all reading one shared,
// last-writer-wins handshake file. Older CC (no env var) falls back to the
// SessionStart hook's project-dir-keyed handshake (the prior mechanism); that
// fallback still collides on same-cwd sessions, but the env var is the norm now.
// Resolved at boot; the background loops + emitAttention await `sessionReady`
// before using it. Keys the MCP server's `sessions` row, SSE subscription,
// steering, and the tap daemon's activity rows off ONE real id.
const PROJECT_CWD = process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
let SESSION_ID = pickEagerSessionId() ?? '';
const DEVICE_ID = readDeviceId();

/** Bounded wait for the SessionStart handshake (MCP server may boot first).
 *  Generous so a slow SessionStart doesn't fall back to a random id (which would
 *  fork this session from the tap daemon's real-id rows). */
const HANDSHAKE_WAIT_MS = 15_000;
const HANDSHAKE_POLL_MS = 250;

const sessionReady: Promise<void> = resolveSessionId().then((id) => {
  SESSION_ID = id;
});

/**
 * Resolve the real session id. Precedence:
 *   1. IMSG_SESSION_ID    — explicit override (tests / manual runs).
 *   2. CLAUDE_CODE_SESSION_ID — Claude Code native (≥2.1.160), authoritative +
 *      synchronous. Fixes same-cwd collisions: each MCP server gets its OWN id.
 *   3. (Codex app-server / `imsg codex`) ASK THE APP-SERVER which thread it hosts
 *      (thread/loaded/list). In `--remote` mode this MCP server is a child of the
 *      shared app-server (not a per-session codex process), so the rollout walk
 *      below is unreliable — but the app-server KNOWS its thread, and the launcher
 *      gives each session its OWN app-server (unique port) so exactly one thread is
 *      loaded. Authoritative; takes precedence over the rollout/handshake.
 *   4. (Codex, plain) the parent codex process's open ROLLOUT file — Codex hands
 *      the MCP server no session id, so we read the real v7 id off our parent's
 *      rollout path (see codex-session.ts). Keyed by OUR process, not the directory.
 *   5. SessionStart handshake (project-dir-keyed) — fallback for older Claude Code
 *      (and a last resort for Codex). Can't tell apart concurrent same-dir sessions
 *      (last writer wins) — so it can adopt a DIFFERENT (even Claude) session's id.
 *   6. random id — last resort (the session just won't correlate with the tap).
 *
 * Housekeeping (plugin install / marketplace validation) sessions never run the
 * background loops (see the boot gate), so their id is unused — short-circuit to a
 * random id rather than probe for one.
 */
async function resolveSessionId(): Promise<string> {
  const eager = pickEagerSessionId();
  if (eager) return eager;
  if (isPluginHousekeepingDir(PROJECT_CWD)) return randomUUID();
  const isCodex = agentKind() === AgentKind.CODEX;

  // Codex hosted on an app-server (`imsg codex`): the app-server is authoritative
  // for which thread (= session) it hosts; the parent-rollout walk below can't see
  // it (our parent is the shared app-server). resolveActiveThreadId polls
  // thread/loaded/list internally, so this one call covers the boot race.
  if (isCodex) {
    const appServer = codexAppServerUrl();
    if (appServer) {
      const tid = await resolveActiveThreadId(appServer);
      if (tid) {
        log('codex_session_from_appserver', { session: tid });
        return tid;
      }
    }
  }

  const deadline = Date.now() + HANDSHAKE_WAIT_MS;
  for (;;) {
    if (isCodex) {
      // Authoritative for Codex: our own parent codex process's rollout id (the
      // same id the tap tails). Preferred over the dir-keyed handshake, which can
      // hold a DIFFERENT agent's id when several sessions share a directory.
      const id = deriveCodexSessionId();
      if (id) {
        log('codex_session_from_rollout', { session: id });
        return id;
      }
    } else {
      // Older Claude Code (no CLAUDE_CODE_SESSION_ID): the project-dir handshake.
      const h = readHandshakeForProject(PROJECT_CWD);
      if (h?.sessionId) return h.sessionId;
    }
    if (Date.now() >= deadline) break;
    await sleep(HANDSHAKE_POLL_MS);
  }
  // Window elapsed. For Codex, fall back to the handshake before a random id (a
  // same-dir collision still correlates better than a fully-orphaned random id).
  if (isCodex) {
    const h = readHandshakeForProject(PROJECT_CWD);
    if (h?.sessionId) {
      log('codex_session_from_handshake', { session: h.sessionId });
      return h.sessionId;
    }
  }
  log('session_id_fallback', {
    reason: isCodex ? 'no_rollout_no_handshake' : 'no_handshake',
    project: PROJECT_CWD,
  });
  return randomUUID();
}

function readDeviceId(): string {
  try {
    return readFileSync(deviceIdFile(), 'utf8').trim();
  } catch {
    return '';
  }
}

// --- MCP server: declare BOTH channel capabilities + the message_user tool ---
// Capabilities + instructions are the EXACT spike wording (neutral, no spike
// branding); only the channel source name changes to the productized id.
const mcp = new Server(
  { name: 'imsg-device', version: '0.1.20' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'You can ask the user questions with the AskUserQuestion tool as normal. To keep the user posted while ' +
      'they drive you remotely, use the `message_user` tool — report your result when you FINISH a task or hit a ' +
      'meaningful milestone (leave expect_reply false; it is delivered and needs no response). IF a hook denies an ' +
      'AskUserQuestion or ExitPlanMode call, the user is away from their keyboard (AFK): follow it — call ' +
      '`message_user` with expect_reply: true and the full question/plan text (all options verbatim), then STOP and ' +
      'end your turn (do not exit, do not guess, do not retry the denied tool). The user\'s reply arrives later as a ' +
      '<channel source="imsg-device"> message; treat it as authoritative and resume. A message forwarded FROM the ' +
      'user tells you whether they are awaiting a reply: it arrives either as <channel source="imsg-device" ' +
      'expect_reply="true"> (or "false") for Claude Code, or with an inline "[The user is awaiting your reply …]" ' +
      'note for Codex. When a reply IS expected, send your answer with the `message_user` tool (the user is remote ' +
      'over iMessage and will NOT see your terminal output); when it is not, fold the message into your work without ' +
      "a forced reply. message_user reaches the " +
      "user's phone over iMessage. message_user normally goes through an orchestrator that condenses it; for the " +
      'rare case where the user must see your EXACT words (a plan, a diff, the precise options when a hook denied ' +
      'AskUserQuestion/ExitPlanMode), set verbatim: true to bypass that condensing — use it sparingly (never for ' +
      'routine status) and FIRST condense your text yourself to under ~1000 characters (about one phone screen); if ' +
      'it is longer it is NOT sent verbatim, the orchestrator summarizes it instead, so keep it tight to preserve ' +
      "your exact words. Use the `rename_session` tool to name this session for what you're working on (and update " +
      'it as the focus shifts) so it is easy to identify on the dashboard.',
  },
);

// message_user: the ONE communication tool the model calls to reach the user. It
// ALWAYS relays the message to the server agent via the /message route (no durable
// attention, no binding, no pending lifecycle). `expect_reply` is just a HINT: when
// true the relay is tagged so the orchestrator surfaces it as a question — the agent
// stops and the user's reply comes back as a <channel> message. The orchestrator (an
// LLM) decides where that reply goes; nothing is locked or auto-bound in code.
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: MESSAGE_USER_TOOL,
      description:
        'Send a message to the user (who is driving you remotely over iMessage). Use this to keep them posted: ' +
        'report your result when you FINISH a task or hit a meaningful milestone (do NOT narrate every step). Leave ' +
        'expect_reply false for those status updates — they are delivered and need no response. Set expect_reply: true ' +
        'when you need an answer to continue (e.g. a hook told you the user is AFK and to relay a question or plan); ' +
        'then STOP and wait — the user\'s reply arrives as a <channel source="imsg-device"> message you should treat ' +
        'as authoritative. Only works while AFK mode is ON; if AFK is off the user is at their keyboard and reads ' +
        'your output directly, so this returns an error (not delivered) — do not call it then.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message to send to the user.' },
          expect_reply: {
            type: 'boolean',
            description:
              'True if you want an answer (you will stop and wait); the orchestrator surfaces your message as a question. Omit/false for status or results.',
          },
          verbatim: {
            type: 'boolean',
            description:
              'Send `text` to the user EXACTLY as written, bypassing the orchestrator that otherwise condenses messages. Use SPARINGLY — only when the user must see your exact words and condensing would lose information: a plan, a diff, a precise list of options to choose from (e.g. after a hook denied AskUserQuestion/ExitPlanMode while AFK). Do NOT use it for routine status/results — leave those default so the orchestrator can frame them. IMPORTANT: condense your text to UNDER ~1000 characters (about one phone screen) BEFORE sending — if it is longer, verbatim is NOT honored and the orchestrator summarizes it regardless, so distill to the essential exact content to keep your words intact. Combine with expect_reply when you also need an answer.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: RENAME_SESSION_TOOL,
      description:
        "Set this session's display name on the dashboard (and the label the user/orchestrator uses to refer to " +
        'you). Call it to name the session for what it is working on, and update it as the focus changes — e.g. ' +
        '"Auth refactor", then "Fixing CI". This sets the session label; it does NOT rename anything in ' +
        'Claude Code itself. Works whether or not AFK is on. A name is required (an empty name is ignored — a label ' +
        `is never blanked). Names are one line, trimmed to ${SESSION_TITLE_MAX_LEN} chars.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              "The session's new display name (a short, non-empty label, e.g. \"Auth refactor\").",
          },
        },
        required: ['name'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === MESSAGE_USER_TOOL) {
    // Read defensively. If a call arrives without a usable `text` (missing key,
    // wrong type, or a non-object/`undefined` arguments payload), every later
    // `text.length` would throw uncaught and surface as an opaque MCP -32603
    // ("undefined is not an object (evaluating 'text.length')") — fooling the
    // agent into retrying the same malformed call forever. Mirror the
    // rename_session handler's typeof guard and fail with a clear tool error.
    const args = (req.params.arguments ?? {}) as {
      text?: unknown;
      expect_reply?: unknown;
      verbatim?: unknown;
    };
    const text = typeof args.text === 'string' ? args.text : '';
    const expect_reply = Boolean(args.expect_reply);
    const verbatim = Boolean(args.verbatim);
    if (!text.trim()) {
      log('message_user_no_text', {});
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              'message_user requires a non-empty `text` string — nothing was sent. ' +
              'Retry with your message in the `text` argument.',
          },
        ],
      };
    }
    // AFK-OFF SHORT-CIRCUIT: at the keyboard the server drops a non-AFK relay
    // (routes/device.ts → {relayed:false}), so relaying is a silent no-op that
    // fools the agent into thinking it notified the user. Fail loudly instead and
    // skip the wasted egress. afk.state is the same fast-local source the
    // PreToolUse hook reads to gate AskUserQuestion (defaults to off).
    const afkOff = messageUserBlockedWhenAfkOff(readAfk());
    if (afkOff) {
      log('message_user_afk_off', {});
      return afkOff;
    }
    const clean = sanitizeText(text);
    // Either way we RELAY (no durable attention, no binding). `expect_reply` only TAGS
    // the relay so the orchestrator surfaces it as a question; `verbatim` asks the server
    // to send the text to the user as-is (LLM bypassed) — but ONLY if it fits one screen;
    // if it's too long the server condenses it via the orchestrator instead of
    // truncating, so no device-side clamp here. The user's reply (if any) comes back as a
    // <channel> message, routed by the LLM.
    await sendStatusMessage(clean, { expectsReply: expect_reply, verbatim });
    log(expect_reply ? 'message_user_ask' : 'message_user_status', {
      len: text.length,
      verbatim,
    });
    return {
      content: [
        {
          type: 'text',
          text: expect_reply ? "sent; the user's reply will come back as a message" : 'sent',
        },
      ],
    };
  }
  if (req.params.name === RENAME_SESSION_TOOL) {
    const { name } = req.params.arguments as { name?: unknown };
    const cleaned = cleanSessionTitle(typeof name === 'string' ? name : '');
    if (!cleaned) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'a non-empty session name is required' }],
      };
    }
    const ok = await renameSession(cleaned);
    if (!ok) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: "couldn't rename the session (device not paired, offline, or disabled)",
          },
        ],
      };
    }
    return {
      content: [{ type: 'text', text: `renamed to "${cleaned}"` }],
    };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

/**
 * Set this session's display name → POST /api/device/session-title. Unlike a
 * status relay this is NOT AFK-gated (a label is session metadata, like the
 * title/cwd that ride the always-on heartbeat) — but it IS killswitch-gated, like
 * every device→server write. The `title` is non-empty (the caller rejects empty).
 * Returns true only on a confirmed write so the tool can report failure to the
 * agent.
 */
async function renameSession(title: string): Promise<boolean> {
  await sessionReady; // rename the REAL session id (matches the tap/heartbeat row)
  const token = loadToken();
  if (!token) {
    log('no_token', { hint: 'run `imsg pair <token>` first' });
    return false;
  }
  if (!(await egressEnabled(token))) {
    log('egress_disabled', {});
    return false;
  }
  try {
    const resp = await postJson(
      deviceApiUrl(DeviceApiRoute.SESSION_TITLE),
      JSON.stringify({ sessionId: SESSION_ID, title }),
      { bearer: token },
    );
    if (resp.classification === Classification.SUCCESS) {
      log('session_renamed', { len: title.length });
      return true;
    }
    log('session_rename_failed', { status: resp.status });
    return false;
  } catch (err) {
    log('session_rename_error', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Fire-and-forget status/result → POST /api/device/message. The server agent
 * relays it and drops it (the SPLIT — no attention, no pending lifecycle). Gated
 * by the killswitch; best-effort (a status update is not safety-critical), never
 * throws. AFK-gating lives server-side (mirrors the attention path).
 */
async function sendStatusMessage(
  text: string,
  opts: { expectsReply?: boolean; verbatim?: boolean } = {},
): Promise<void> {
  await sessionReady; // tag under the REAL session id so the relay attributes it
  const token = loadToken();
  if (!token) {
    log('no_token', { hint: 'run `imsg pair <token>` first' });
    return;
  }
  if (!(await egressEnabled(token))) {
    log('egress_disabled', {});
    return;
  }
  try {
    const resp = await postJson(
      deviceApiUrl(DeviceApiRoute.MESSAGE),
      JSON.stringify({
        sessionId: SESSION_ID,
        text,
        expectsReply: opts.expectsReply ?? false,
        verbatim: opts.verbatim ?? false,
      }),
      { bearer: token },
    );
    if (resp.classification === Classification.SUCCESS) log('status_sent', { len: text.length });
    else log('status_send_failed', { status: resp.status });
  } catch (err) {
    log('status_send_error', { error: err instanceof Error ? err.message : String(err) });
  }
}

// permission relay: Claude Code notifies us a tool dialog opened. We turn it
// into an AttentionEvent (PERMISSION) carrying the request_id so the verdict
// arriving via /api/device/decisions can be matched back to this prompt.
const PermissionRequestSchema = z.object({
  method: z.literal(ChannelMethod.PERMISSION_REQUEST),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  log('permission_request', { request_id: params.request_id, tool_name: params.tool_name });
  await emitAttention({
    kind: AttentionKind.PERMISSION,
    toolName: params.tool_name,
    description: sanitizeText(params.description),
    inputPreview: sanitizeText(params.input_preview),
    requestId: params.request_id,
  });
});

// --- attention egress: enqueue + drain to the cloud control plane -----------
let pendingCount = 0;
async function emitAttention(
  partial: Pick<AttentionEvent, 'kind'> &
    Partial<Pick<AttentionEvent, 'toolName' | 'description' | 'inputPreview' | 'requestId' | 'qid'>>,
): Promise<void> {
  await sessionReady; // ensure the real session id is resolved before tagging
  const evt: AttentionEvent = {
    id: randomUUID(),
    deviceId: DEVICE_ID,
    sessionId: SESSION_ID,
    kind: partial.kind,
    toolName: partial.toolName,
    description: sanitizeOptional(partial.description),
    inputPreview: sanitizeOptional(partial.inputPreview),
    requestId: partial.requestId,
    qid: partial.qid,
    createdAt: new Date().toISOString(),
  };
  enqueue([evt]);
  pendingCount += 1;
  writePending(pendingCount);
  await drainOutbox();
}

async function drainOutbox(): Promise<void> {
  const token = loadToken();
  if (!token) {
    log('no_token', { hint: 'run `imsg pair <token>` first' });
    return;
  }
  if (!(await egressEnabled(token))) {
    log('egress_disabled', {});
    return;
  }
  try {
    const shipped = await drain(token);
    if (shipped > 0) log('outbox_drained', { shipped });
  } catch (err) {
    if (err instanceof HaltError) {
      log('halt', { reason: '401 device token revoked' });
    } else {
      log('drain_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// --- session inbox: apply pushed rows + ACK back ------------------------------
// The control plane pushes ONE kind of thing now: session_inbox rows. Each is
// either a `reply` (inject into the session as a <channel> message) or a
// `verdict` (relay on the permission channel to release a parked prompt — the
// fail-CLOSED approval path: we only ever relay a verdict we explicitly received,
// carrying its request_id; absence = no send).

// Idempotency: inject each row at most once per process. A reconnect/restart (or
// a lost ACK) can make the server re-serve a still-undelivered row; without this
// the agent re-ran the same answer every reconnect (the duplicate-reply loop).
// The server-side delivered_at (set on ACK) is the durable guard; this is the
// in-process belt-and-suspenders.
const appliedInbox = new Set<string>();
const APPLIED_INBOX_CAP = 500;

// Returns whether the row was DELIVERED (or definitively un-deliverable) and so
// should be ACKed. A transient delivery failure (Codex app-server injection that
// didn't land) returns false → the caller skips the ACK and the control plane
// re-serves the row on the next SSE flush. The claude/channel notification path is
// fire-and-forget (no failure signal), so it always reports delivered — preserving
// the prior always-ACK behavior for Claude Code.
async function applyInbox(item: InboxItem): Promise<boolean> {
  if (appliedInbox.has(item.id)) {
    // Already applied; the re-send means a prior ACK didn't stick. Skip
    // re-injection — but report delivered so the caller re-ACKs and the server
    // stops re-serving it.
    log('inbox_dup_skipped', { id: item.id });
    return true;
  }

  if (item.kind === 'verdict') {
    // A permission verdict → relay on the permission channel. Fail-CLOSED: relay
    // only a fully-specified verdict (never synthesize an allow). An unbound
    // verdict can never be delivered, so ACK it (true) to stop re-serving forever.
    if (item.requestId && item.behavior) {
      await mcp.notification({
        method: ChannelMethod.PERMISSION,
        params: { request_id: item.requestId, behavior: item.behavior },
      });
      log('verdict_relayed', { request_id: item.requestId, behavior: item.behavior });
    } else {
      log('verdict_unbound', { id: item.id });
    }
  } else {
    // A reply → deliver into the session. Codex isn't a Claude Code Channels client,
    // so the claude/channel notification below is silently dropped for it; when the
    // user launched via `imsg codex` (codexAppServerUrl set) we instead inject the
    // reply as a real user turn over the app-server (see codex-appserver.ts).
    const appServer = agentKind() === AgentKind.CODEX ? codexAppServerUrl() : '';
    if (appServer) {
      const res = await injectReply({
        url: appServer,
        threadId: SESSION_ID, // thread.id === Codex session id
        text: item.text ?? '',
        expectReply: Boolean(item.expectReply),
        log,
      });
      if (!res.ok) {
        // Not delivered — leave un-ACked so the control plane re-serves it (e.g.
        // a turn was active; it should land on a later flush). Do NOT mark applied.
        log('codex_reply_undelivered', { id: item.id, reason: res.reason });
        return false;
      }
      log('reply_injected_codex', { id: item.id, len: (item.text ?? '').length });
    } else {
      // Claude Code (or Codex without the app-server launcher): push as a <channel>
      // message. Fire-and-forget — treated as delivered (no failure signal).
      await mcp.notification({
        method: ChannelMethod.CHANNEL,
        params: {
          content: item.text ?? '',
          // meta entries become attributes on the <channel> tag the model reads. Values
          // must be strings; `expect_reply` (always present) tells the agent whether the
          // user is awaiting a reply — see the server instructions.
          meta: {
            source_kind: 'imsg_phone',
            message_id: item.id,
            attention_id: item.attentionId,
            expect_reply: String(Boolean(item.expectReply)),
          },
        },
      });
      log('reply_pushed', { id: item.id, len: (item.text ?? '').length });
    }
  }

  // A row that resolves a pending attention clears one from the statusline count
  // (a free steer has no attention_id and leaves the count alone).
  if (item.attentionId) {
    pendingCount = Math.max(0, pendingCount - 1);
    writePending(pendingCount);
  }

  appliedInbox.add(item.id);
  if (appliedInbox.size > APPLIED_INBOX_CAP) {
    const oldest = appliedInbox.values().next().value; // Set keeps insertion order
    if (oldest !== undefined) appliedInbox.delete(oldest);
  }
  return true;
}

/**
 * ACK injected inbox rows back to the control plane (by id) so it sets
 * delivered_at and stops re-serving them. Best-effort: the in-process dedup
 * already prevents re-injection, so a failed ack only means a harmless re-send
 * later. Never throws.
 */
async function ackInbox(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const token = loadToken();
  if (!token) return;
  try {
    const resp = await postJson(
      deviceApiUrl(DeviceApiRoute.ACK),
      JSON.stringify({ sessionId: SESSION_ID, ids }),
      { bearer: token },
    );
    if (resp.classification === Classification.SUCCESS) {
      log('inbox_acked', { count: ids.length });
    } else {
      log('ack_failed', { status: resp.status });
    }
  } catch (err) {
    log('ack_error', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Parse one SSE frame's `event:` + concatenated `data:` lines (ignore comments/id). */
function parseSSEFrame(frame: string): { event: string; data: string } {
  let event = 'message';
  const data: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return { event, data: data.join('\n') };
}

/**
 * Subscribe to the control plane's SSE event stream and REACT to pushed events
 * (session_inbox rows + afk state) — no polling. The server re-serves undelivered
 * rows on every flush until we ACK, so a clean reconnect replays anything missed;
 * the server's 'ping' keeps the stream warm. On a FAILED connect we back off
 * fast-first (a transient blip must not cost 5s of dead air — a queued message
 * would wait that long) up to a 5s cap; a clean stream-end reconnects immediately.
 */
async function subscribeEvents(): Promise<void> {
  await sessionReady; // subscribe under the REAL session id (so rows reach us)
  let failures = 0; // consecutive connect failures → backoff; reset on a live stream
  for (;;) {
    const token = loadToken();
    if (!token) {
      await sleep(5_000);
      continue;
    }
    try {
      const url =
        deviceApiUrl(DeviceApiRoute.EVENTS) +
        `?sessionId=${encodeURIComponent(SESSION_ID)}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      });
      if (resp.status === 401) {
        log('events_halt', { reason: '401 device token revoked' });
        await sleep(30_000);
        continue;
      }
      if (!resp.ok || !resp.body) {
        await sleep(reconnectBackoffMs((failures += 1)));
        continue;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let sawData = false; // reset backoff only once the stream actually yields bytes
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!sawData) {
          sawData = true;
          failures = 0; // a live, byte-yielding stream — clear the backoff
        }
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          if (!frame.trim()) continue;
          const { event, data } = parseSSEFrame(frame);
          if (!data) continue;
          try {
            if (event === SseEvent.INBOX) {
              const body = JSON.parse(data) as { items?: InboxItem[] };
              const items = body.items ?? [];
              // ACK only rows that were actually DELIVERED (or are undeliverable):
              // a Codex injection that didn't land returns false and stays un-ACked
              // so the server re-serves it next flush. Fire-and-forget the ACK so
              // the read loop isn't held on the round-trip.
              const deliveredIds: string[] = [];
              for (const it of items) {
                if (await applyInbox(it)) deliveredIds.push(it.id);
              }
              if (deliveredIds.length > 0) void ackInbox(deliveredIds);
            } else if (event === SseEvent.STATE) {
              // Mirror the control plane's afk into the local afk.state file the
              // PreToolUse hook reads — a dashboard/CLI toggle reaching the hook.
              // GUARD: never adopt while a local toggle is still dirty (its POST may
              // have been lost). Otherwise a stale server value pushed on a new
              // session's first flush would silently REVERT a fresh local toggle —
              // the revert race. The heartbeat re-asserts the dirty value up and
              // clears the flag once the cloud confirms.
              const body = JSON.parse(data) as { afk?: string };
              if (
                isAfkState(body.afk) &&
                shouldAdoptDownstreamAfk({ pushedAfk: body.afk, dirty: readAfkDirty(), localAfk: readAfk() })
              ) {
                writeAfk(body.afk);
                // Match the keep-awake to a remote/dashboard toggle too: an AFK-on
                // pushed to an unattended Mac is exactly when an idle sleep would
                // drop the session. Best-effort + macOS-only; idempotent across the
                // many sessions that receive this same push (see reconcileCaffeinate).
                reconcileCaffeinate(body.afk);
                log('afk_synced', { afk: body.afk });
              } else if (isAfkState(body.afk) && readAfkDirty() && body.afk === readAfk()) {
                // The server already holds our pending toggle (this push came from the
                // device_state NOTIFY our own reconcile fired). Clear dirty here too,
                // so a dirty flag can't wedge if the heartbeat echo path is starved
                // (e.g. egress killswitched) — without it, every later dashboard afk
                // change would be ignored indefinitely.
                writeAfkDirty(false);
                log('afk_sync_confirmed', { afk: body.afk, via: 'sse' });
              }
            }
            // SseEvent.PING (keepalive) + unknown events: ignore.
          } catch (err) {
            log('event_apply_error', {
              event,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      // Stream ended. If it yielded data first (a healthy cycle), reconnect
      // immediately (failures was reset). If it 200'd then EOF'd without a single
      // byte, treat it as a failed connect and back off — else a server that
      // accepts-then-drops would spin us in a hot reconnect loop.
      if (!sawData) await sleep(reconnectBackoffMs((failures += 1)));
    } catch (err) {
      // Include the URL we tried: a stale process resolving the localhost
      // default vs. the baked prod host is the usual cause, and this makes the
      // mismatch obvious at a glance in channel.log.
      log('events_error', {
        url: deviceApiUrl(DeviceApiRoute.EVENTS),
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(reconnectBackoffMs((failures += 1)));
    }
  }
}

/** Reconnect backoff after a FAILED connect: fast first retry (~300ms, so a
 *  transient blip doesn't strand a queued message for 5s), exponential up to a
 *  5s cap, with jitter to avoid synchronized reconnect storms across sessions. */
function reconnectBackoffMs(failures: number): number {
  const base = Math.min(300 * 2 ** Math.max(0, failures - 1), 5_000);
  return base + Math.floor(Math.random() * 250);
}

// --- heartbeat: liveness + session touch + dirty-afk reconcile ----------------
// afk normally flows DOWN (the `state` SSE event from a dashboard/CLI toggle). The
// ONE exception: while a local toggle is DIRTY (its POST /api/device/state may have
// been lost), the heartbeat re-asserts {afk, afkDirty:true} UP. The server adopts a
// dirty value (the device is authoritative for its own machine afk) and echoes its
// resulting afk; the loop clears the flag once that echo confirms the toggle landed.
// A non-dirty heartbeat sends no afk, so it can never clobber a dashboard change.

/** The session title captured locally by the tap daemon — Claude Code's own
 *  ai-title / a /rename custom-title, else the provisional first message — or
 *  undefined if not yet observed. Forwarded on the heartbeat as session metadata
 *  (like cwd) so it populates regardless of AFK. */
function readSessionTitle(): string | undefined {
  try {
    const t = readFileSync(sessionTitleFile(SESSION_ID), 'utf8').trim();
    return t || undefined;
  } catch {
    return undefined; // not captured yet — readers fall back to cwd
  }
}

/** The last title value we actually SHIPPED on a heartbeat (persisted), or
 *  undefined if we never have. The title rides the beat EDGE-TRIGGERED — only when
 *  the current auto-title differs from this — so a steady beat never re-asserts it
 *  and thus never clobbers a server-side rename (orchestrator / dashboard) in the
 *  single `title` column. Persisted across restarts for the same reason. */
function readLastSentTitle(): string | undefined {
  try {
    const t = readFileSync(sessionTitleSentFile(SESSION_ID), 'utf8').trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

/** Record the title we just shipped (call only after a confirmed send, so a failed
 *  beat re-sends next time instead of going silent). Atomic tmp+rename (matching the
 *  tap's `<id>.title` write) so a crash mid-write can't leave a truncated marker that
 *  reads back as a "changed" title and triggers a spurious re-assert. Best-effort —
 *  the sessions dir already exists here (we only persist after readSessionTitle read
 *  the live title from it). */
function writeLastSentTitle(title: string): void {
  try {
    const path = sessionTitleSentFile(SESSION_ID);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, title, 'utf8');
    renameSync(tmp, path);
  } catch {
    /* best-effort: a missed persist just means we re-send the same title next beat */
  }
}

async function heartbeatLoop(): Promise<void> {
  await sessionReady; // beat under the REAL session id (so the row matches the tap)
  for (;;) {
    const token = loadToken();
    const enabled = token ? await egressEnabled(token).catch(() => true) : false;
    if (token && enabled) {
      // Re-assert afk up ONLY while a local toggle is dirty (un-acked). The local
      // afk is captured before the POST so the echo comparison below is against the
      // value we actually asserted.
      const dirty = readAfkDirty();
      const localAfk = readAfk();
      // Edge-triggered title: ship it ONLY when our auto-title changed since the
      // last beat we sent it on. A steady beat sends no title → the server's
      // COALESCE(EXCLUDED.title, …) keeps the current value, so a server-side
      // rename (orchestrator / dashboard, written into the single `title` column)
      // is never clobbered by re-assertion. Persisted across restarts.
      const curTitle = readSessionTitle();
      const titleToSend =
        curTitle !== undefined && curTitle !== readLastSentTitle() ? curTitle : undefined;
      const body = JSON.stringify({
        sessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        agent: agentKind(),
        hostname: hostname(),
        // CLAUDE_PROJECT_DIR (the real project dir), NOT process.cwd() — the MCP
        // server's cwd is forced to CLAUDE_PLUGIN_ROOT by .mcp.json's --cwd.
        cwd: PROJECT_CWD,
        // Only when changed (see above); omitted otherwise so it never re-asserts.
        ...(titleToSend !== undefined ? { title: titleToSend } : {}),
        ...(dirty ? { afk: localAfk, afkDirty: true } : {}),
        at: new Date().toISOString(),
      });
      const resp = await postJson(deviceApiUrl(DeviceApiRoute.HEARTBEAT), body, { bearer: token });
      // Record the shipped title only on a confirmed send, so a failed beat
      // re-sends next time instead of silently dropping the change.
      if (titleToSend !== undefined && resp.classification === Classification.SUCCESS) {
        writeLastSentTitle(titleToSend);
      }
      if (resp.classification === Classification.HALT) log('heartbeat_halt', { reason: '401' });
      // Clear the dirty flag once the server echoes an afk matching what we asserted
      // — the toggle has landed in the cloud (and triggered the afk-off wipe, if any).
      else if (dirty && resp.classification === Classification.SUCCESS) {
        try {
          const r = JSON.parse(resp.body) as { afk?: string };
          // Re-read afk NOW: if a concurrent `imsg afk` toggle changed it during this
          // in-flight beat, it re-set dirty for a NEW value — clearing on this stale
          // echo would drop that toggle's self-heal. Only clear when local still
          // equals what we actually asserted. (TOCTOU guard.)
          if (
            readAfk() === localAfk &&
            shouldClearDirty({ wasDirty: dirty, success: true, echoAfk: r.afk, localAfk })
          ) {
            writeAfkDirty(false);
            log('afk_sync_confirmed', { afk: r.afk });
          }
        } catch {
          /* malformed body — stay dirty, retry next heartbeat */
        }
      }
    }
    await drainOutbox(); // also flush any backlog on the heartbeat cadence
    await sleep(HEARTBEAT_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- boot --------------------------------------------------------------------
await mcp.connect(new StdioServerTransport());
log('connected', { device: DEVICE_ID, project: PROJECT_CWD, control: deviceApiUrl(DeviceApiRoute.ATTENTION) });

// Codex boots this MCP server even for its OWN plugin install / marketplace
// validation sessions (rooted under ~/.codex/{plugins,marketplaces}/…). Those
// carry no user, so we stay connected (Codex expects the configured server) but
// never run the heartbeat/SSE loops — a heartbeat would register a titleless
// dashboard session row labelled by the plugin's version folder. This is the
// path that actually creates those rows (the MCP server's random-id fallback),
// so the SessionStart tap guard alone is not enough.
if (isPluginHousekeepingDir(PROJECT_CWD)) {
  log('housekeeping_session_inert', { project: PROJECT_CWD });
} else {
  // Self-heal the keep-awake to the CURRENT AFK state on boot. reconcileCaffeinate
  // otherwise only fires on an AFK *transition* (the imsg afk CLI or an SSE
  // down-push), so a session that starts — or a plugin reinstalled — while AFK is
  // ALREADY on would hold no caffeinate until the next toggle. Reconciling here
  // makes "AFK on ⟺ Mac kept awake" hold from the first moment too. Machine-wide +
  // idempotent, so concurrent sessions booting converge on a single caffeinate.
  reconcileCaffeinate(readAfk());

  // Session id resolves async from the handshake; record it once known.
  void sessionReady.then(() => log('session_resolved', { session: SESSION_ID }));

  // Fire the background loops; they own their own retry/backoff and never throw
  // out (errors are logged + retried) so the MCP stdio loop stays alive. Each
  // awaits `sessionReady` so it operates under the real session id.
  void subscribeEvents();
  void heartbeatLoop();
}
