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
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  AttentionKind,
  ChannelMethod,
  DeviceApiRoute,
  MESSAGE_USER_TOOL,
  SseEvent,
  type AttentionEvent,
  type InboxItem,
  isAfkState,
} from '@imsg/shared';
import {
  HEARTBEAT_INTERVAL_MS,
  agentKind,
  deviceApiUrl,
  deviceIdFile,
  logDir,
  migrateLegacyDeviceDir,
  pickEagerSessionId,
  sessionTitleFile,
} from './config.ts';
import { loadToken } from './creds.ts';
import { readHandshakeForProject } from './handshake.ts';
import { Classification, postJson } from './httpclient.ts';
import { HaltError, drain, enqueue } from './outbox.ts';
import { egressEnabled } from './killswitch.ts';
import { sanitizeOptional, sanitizeText } from './sanitize.ts';
import { readAfk, writeAfk, writePending } from './state.ts';

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
 * Resolve the real CC session id. Precedence:
 *   1. IMSG_SESSION_ID    — explicit override (tests / manual runs).
 *   2. CLAUDE_CODE_SESSION_ID — CC-native (≥2.1.160), authoritative + synchronous.
 *      This is the fix for same-cwd collisions: each MCP server gets its OWN id.
 *   3. SessionStart handshake (project-dir-keyed) — fallback for older CC, polled
 *      briefly in case the MCP server booted before the hook wrote it. SessionEnd
 *      deletes the handshake, so a present one belongs to the live session here.
 *   4. random id — last resort (degrades to the old behavior; the session just
 *      won't correlate with the tap).
 *
 * NOTE: the handshake fallback (3) still can't disambiguate concurrent same-cwd
 * sessions (last writer wins) — but on CC ≥2.1.160 (2) wins first, so it does.
 */
async function resolveSessionId(): Promise<string> {
  const eager = pickEagerSessionId();
  if (eager) return eager;
  const deadline = Date.now() + HANDSHAKE_WAIT_MS;
  for (;;) {
    const h = readHandshakeForProject(PROJECT_CWD);
    if (h?.sessionId) return h.sessionId;
    if (Date.now() >= deadline) {
      log('session_id_fallback', { reason: 'no_handshake', project: PROJECT_CWD });
      return randomUUID();
    }
    await sleep(HANDSHAKE_POLL_MS);
  }
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
  { name: 'imsg-device', version: '0.1.10' },
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
      '<channel source="imsg-device"> message; treat it as authoritative and resume. message_user reaches the ' +
      "user's phone over iMessage.",
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
        'as authoritative.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message to send to the user.' },
          expect_reply: {
            type: 'boolean',
            description:
              'True if you want an answer (you will stop and wait); the orchestrator surfaces your message as a question. Omit/false for status or results.',
          },
        },
        required: ['text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === MESSAGE_USER_TOOL) {
    const { text, expect_reply } = req.params.arguments as {
      text: string;
      expect_reply?: boolean;
    };
    const clean = sanitizeText(text);
    // Either way we RELAY (no durable attention, no binding). `expect_reply` only
    // TAGS the relay so the orchestrator surfaces it as a question; the agent stops
    // and the user's reply comes back as a <channel> message, routed by the LLM.
    await sendStatusMessage(clean, { expectsReply: Boolean(expect_reply) });
    log(expect_reply ? 'message_user_ask' : 'message_user_status', { len: text.length });
    return {
      content: [
        {
          type: 'text',
          text: expect_reply ? "sent; the user's reply will come back as a message" : 'sent',
        },
      ],
    };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

/**
 * Fire-and-forget status/result → POST /api/device/message. The server agent
 * relays it and drops it (the SPLIT — no attention, no pending lifecycle). Gated
 * by the killswitch; best-effort (a status update is not safety-critical), never
 * throws. AFK-gating lives server-side (mirrors the attention path).
 */
async function sendStatusMessage(
  text: string,
  opts: { expectsReply?: boolean } = {},
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
      JSON.stringify({ sessionId: SESSION_ID, text, expectsReply: opts.expectsReply ?? false }),
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

async function applyInbox(item: InboxItem): Promise<void> {
  if (appliedInbox.has(item.id)) {
    // Already applied; the re-send means a prior ACK didn't stick. Skip
    // re-injection — the caller still re-ACKs so the server stops re-serving it.
    log('inbox_dup_skipped', { id: item.id });
    return;
  }

  if (item.kind === 'verdict') {
    // A permission verdict → relay on the permission channel. Fail-CLOSED: relay
    // only a fully-specified verdict (never synthesize an allow).
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
    // A reply → push into the session as a <channel> message.
    await mcp.notification({
      method: ChannelMethod.CHANNEL,
      params: {
        content: item.text ?? '',
        meta: { source_kind: 'imsg_phone', message_id: item.id, attention_id: item.attentionId },
      },
    });
    log('reply_pushed', { id: item.id, len: (item.text ?? '').length });
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
              for (const it of items) await applyInbox(it);
              // ACK every row in the frame (injected or dup-skipped) so the server
              // sets delivered_at and stops re-serving. Fire-and-forget so the read
              // loop isn't held on the round-trip.
              if (items.length > 0) void ackInbox(items.map((it) => it.id));
            } else if (event === SseEvent.STATE) {
              // Mirror the control plane's authoritative afk into the local
              // afk.state file the PreToolUse hook reads (guarded: write on
              // change). This is the dashboard/CLI toggle reaching the hook.
              const body = JSON.parse(data) as { afk?: string };
              if (isAfkState(body.afk) && body.afk !== readAfk()) {
                writeAfk(body.afk);
                log('afk_synced', { afk: body.afk });
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

// --- heartbeat: liveness + session touch -------------------------------------
// NOTE: afk is NOT sent up here. The control plane is the source of truth: afk
// flows DOWN to the device via the `state` SSE event (set from the dashboard or
// the CLI's POST /api/device/state), and the heartbeat route ignores any afk in
// the body anyway. Sending it would falsely imply an up-sync and risk clobbering
// the authoritative value.

/** The session title captured locally by the tap daemon — Claude Code's own
 *  ai-title / a /rename custom-title, else the provisional first message — or
 *  undefined if not yet observed. Forwarded on the heartbeat as session metadata
 *  (like cwd) so it populates regardless of AFK; the server keeps the newest. */
function readSessionTitle(): string | undefined {
  try {
    const t = readFileSync(sessionTitleFile(SESSION_ID), 'utf8').trim();
    return t || undefined;
  } catch {
    return undefined; // not captured yet — readers fall back to cwd
  }
}

async function heartbeatLoop(): Promise<void> {
  await sessionReady; // beat under the REAL session id (so the row matches the tap)
  for (;;) {
    const token = loadToken();
    const enabled = token ? await egressEnabled(token).catch(() => true) : false;
    if (token && enabled) {
      const body = JSON.stringify({
        sessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        agent: agentKind(),
        hostname: hostname(),
        // CLAUDE_PROJECT_DIR (the real project dir), NOT process.cwd() — the MCP
        // server's cwd is forced to CLAUDE_PLUGIN_ROOT by .mcp.json's --cwd.
        cwd: PROJECT_CWD,
        // Omitted (dropped by JSON.stringify) until the tap captures it.
        title: readSessionTitle(),
        at: new Date().toISOString(),
      });
      const resp = await postJson(deviceApiUrl(DeviceApiRoute.HEARTBEAT), body, { bearer: token });
      if (resp.classification === Classification.HALT) log('heartbeat_halt', { reason: '401' });
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
// Session id resolves async from the handshake; record it once known.
void sessionReady.then(() => log('session_resolved', { session: SESSION_ID }));

// Fire the background loops; they own their own retry/backoff and never throw
// out (errors are logged + retried) so the MCP stdio loop stays alive. Each
// awaits `sessionReady` so it operates under the real session id.
void subscribeEvents();
void heartbeatLoop();
