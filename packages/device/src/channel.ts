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
 *   - verdicts + answers + remote grant changes arrive over the SSE stream
 *     GET /api/device/events; a verdict is relayed back to Claude Code via the
 *     claude/channel/permission notification, an answer is pushed into the
 *     session as a <channel> message, and a grant escalation is written to the
 *     local grant.state so the PreToolUse hook honors it. After injecting, the
 *     device POSTs /api/device/ack so the server marks those decisions delivered
 *     and never re-serves them (at-least-once + in-process dedup).
 *   - afk/grant are mirrored from the local state files (set by the CLI and by
 *     this server when it learns of a remote change) and heartbeated up.
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
  AgentKind,
  AttentionKind,
  ChannelMethod,
  DecisionBehavior,
  DeviceApiRoute,
  GrantLevel,
  SseEvent,
  type AttentionEvent,
  type Decision,
  isAfkState,
  isDecisionBehavior,
  isGrantLevel,
} from '@imsg/shared';
import {
  HEARTBEAT_INTERVAL_MS,
  deviceApiUrl,
  deviceIdFile,
  logDir,
  pickEagerSessionId,
  sessionTitleFile,
} from './config.ts';
import { loadToken } from './creds.ts';
import { readHandshakeForProject } from './handshake.ts';
import { Classification, postJson } from './httpclient.ts';
import { HaltError, drain, enqueue } from './outbox.ts';
import { egressEnabled } from './killswitch.ts';
import { sanitizeOptional, sanitizeText } from './sanitize.ts';
import { readAfk, readGrant, writeAfk, writeGrant, writePending } from './state.ts';

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
  { name: 'imsg-device', version: '0.1.5' },
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
      '`message_user` with expect_reply: true, the full question/plan text (all options verbatim), and the reply_tag ' +
      'it gives you, then STOP and end your turn (do not exit, do not guess, do not retry the denied tool). Their ' +
      'answer arrives later as a <channel source="imsg-device"> message; match it by reply_tag, treat it as ' +
      "authoritative, and resume. message_user reaches the user's phone over iMessage.",
  },
);

// message_user: the ONE communication tool the model calls to reach the user.
// Two modes, split by expect_reply:
//   expect_reply=false (default) → STATUS/RESULT. Fire-and-forget: POST to the
//     /message route; the server agent relays it and drops it (no attention,
//     no pending lifecycle).
//   expect_reply=true            → NEEDS AN ANSWER. Durable round-trip via the
//     attention path (QUESTION); the agent stops and waits, and the user's answer
//     is pushed back as a <channel> message.
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'message_user',
      description:
        'Send a message to the user (who is driving you remotely over iMessage). Use this to keep them posted: ' +
        'report your result when you FINISH a task or hit a meaningful milestone (do NOT narrate every step). Leave ' +
        'expect_reply false for those status updates — they are delivered and need no response. Set expect_reply: true ' +
        'ONLY when you genuinely need an answer to continue (e.g. a hook just told you the user is AFK and to relay a ' +
        'question or plan); then STOP and wait — the answer arrives as a <channel source="imsg-device"> message you ' +
        'should treat as authoritative.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message to send to the user.' },
          expect_reply: {
            type: 'boolean',
            description:
              'True only if you need an answer before continuing (you will stop and wait). Omit/false for status or results.',
          },
          reply_tag: {
            type: 'string',
            description:
              'Optional correlation id echoed back with the answer (use the reply_tag a hook gave you). Only meaningful with expect_reply: true.',
          },
        },
        required: ['text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'message_user') {
    const { text, expect_reply, reply_tag } = req.params.arguments as {
      text: string;
      expect_reply?: boolean;
      reply_tag?: string;
    };
    const clean = sanitizeText(text);
    if (expect_reply) {
      // Needs an answer → durable round-trip via the attention path. The agent
      // stops and waits; the user's answer is pushed back as a <channel> message.
      await emitAttention({
        kind: AttentionKind.QUESTION,
        description: clean,
        qid: reply_tag ?? randomUUID(),
      });
      log('message_user_ask', { len: text.length });
      return { content: [{ type: 'text', text: "sent; waiting for the user's reply" }] };
    }
    // Fire-and-forget status/result → relayed by the server agent and dropped.
    await sendStatusMessage(clean);
    log('message_user_status', { len: text.length });
    return { content: [{ type: 'text', text: 'sent' }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

/**
 * Fire-and-forget status/result → POST /api/device/message. The server agent
 * relays it and drops it (the SPLIT — no attention, no pending lifecycle). Gated
 * by the killswitch; best-effort (a status update is not safety-critical), never
 * throws. AFK-gating lives server-side (mirrors the attention path).
 */
async function sendStatusMessage(text: string): Promise<void> {
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
      JSON.stringify({ sessionId: SESSION_ID, text }),
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

// --- decision long-poll: pull verdicts/answers/grants from the control plane -
// Applying a Decision (the fail-CLOSED approval path lives here on the relay
// side: we only ever SEND a verdict we explicitly received; absence = no send).

// Idempotency for decisions (mirrors appliedSteers): an attention resolves to
// exactly ONE decision, so its attentionId is a stable key. A reconnect/restart
// (or a lost ACK) can make the server re-serve a still-undelivered decision; we
// inject it at most once per process — without this, the agent re-ran the same
// answer every reconnect (the duplicate-reply loop). The server-side delivered_at
// (set on ACK) is the durable guard; this is the in-process belt-and-suspenders.
const appliedDecisions = new Set<string>();
const APPLIED_DECISIONS_CAP = 500;

async function applyDecision(d: Decision, requestIdByAttention: Map<string, string>): Promise<void> {
  if (appliedDecisions.has(d.attentionId)) {
    // Already applied in this process; the re-send means a prior ACK didn't
    // stick. Skip re-injection — the caller still re-ACKs so the server marks it
    // delivered and stops re-serving it.
    log('decision_dup_skipped', { attentionId: d.attentionId });
    return;
  }
  // Grant escalation (e.g. plan approved as "edits"/"full" from the phone) is
  // written locally so the PreToolUse hook honors it on the next tool call.
  if (d.grant && isGrantLevel(d.grant) && d.grant !== readGrant()) {
    writeGrant(d.grant as GrantLevel);
    log('grant_synced', { grant: d.grant });
  }

  // A permission verdict → relay back to Claude Code on the permission channel.
  if (d.behavior && isDecisionBehavior(d.behavior)) {
    const requestId = requestIdByAttention.get(d.attentionId);
    if (requestId) {
      await mcp.notification({
        method: ChannelMethod.PERMISSION,
        params: { request_id: requestId, behavior: d.behavior },
      });
      log('verdict_relayed', { request_id: requestId, behavior: d.behavior });
    } else {
      // No request_id binding for this decision: it's not a permission verdict
      // we can relay. Fail-CLOSED — do nothing (never synthesize an allow).
      log('verdict_unbound', { attentionId: d.attentionId, behavior: d.behavior });
    }
    if (d.behavior === DecisionBehavior.ALLOW || d.behavior === DecisionBehavior.DENY) {
      pendingCount = Math.max(0, pendingCount - 1);
      writePending(pendingCount);
    }
  }

  // An answer (question/plan) → push into the session as a <channel> message.
  if (d.answerText) {
    await mcp.notification({
      method: ChannelMethod.CHANNEL,
      params: {
        content: d.answerText,
        meta: { source_kind: 'imsg_phone', attention_id: d.attentionId },
      },
    });
    log('answer_pushed', { attentionId: d.attentionId, len: d.answerText.length });
    pendingCount = Math.max(0, pendingCount - 1);
    writePending(pendingCount);
  }

  appliedDecisions.add(d.attentionId);
  if (appliedDecisions.size > APPLIED_DECISIONS_CAP) {
    const oldest = appliedDecisions.values().next().value; // Set keeps insertion order
    if (oldest !== undefined) appliedDecisions.delete(oldest);
  }
}

/**
 * ACK delivered decisions back to the control plane (by attentionId) so it marks
 * them delivered and stops re-serving them on the next flush. Best-effort: the
 * in-process dedup already prevents re-injection, so a failed ack only means a
 * harmless re-send later. Never throws.
 */
async function ackDecisions(attentionIds: string[]): Promise<void> {
  if (attentionIds.length === 0) return;
  const token = loadToken();
  if (!token) return;
  try {
    const resp = await postJson(
      deviceApiUrl(DeviceApiRoute.ACK),
      JSON.stringify({ sessionId: SESSION_ID, attentionIds }),
      { bearer: token },
    );
    if (resp.classification === Classification.SUCCESS) {
      log('decisions_acked', { count: attentionIds.length });
    } else {
      log('ack_failed', { status: resp.status });
    }
  } catch (err) {
    log('ack_error', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * ACK injected STEERS back to the control plane (by message id) so it sets
 * `acked_at` — the delivery-confirmation signal the orchestrator's per-turn
 * watcher waits on (distinct from `delivered_at`, which the server sets on SSE
 * write for re-serve dedup). Mirrors ackDecisions; best-effort, never throws.
 */
async function ackSteers(messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  const token = loadToken();
  if (!token) return;
  try {
    const resp = await postJson(
      deviceApiUrl(DeviceApiRoute.ACK),
      JSON.stringify({ sessionId: SESSION_ID, messageIds }),
      { bearer: token },
    );
    if (resp.classification === Classification.SUCCESS) {
      log('steers_acked', { count: messageIds.length });
    } else {
      log('steer_ack_failed', { status: resp.status });
    }
  } catch (err) {
    log('steer_ack_error', { error: err instanceof Error ? err.message : String(err) });
  }
}

interface DecisionsResponse {
  decisions?: Decision[];
  /** Server maps each resolved attentionId back to its channel request_id. */
  requestIds?: Record<string, string>;
  since?: string;
}

// Idempotency for steers: the server marks a steer delivered after the SSE write,
// but a failed mark (DB blip) could re-deliver it on reconnect. Dedupe by message
// id so a steer is injected at most once. Bounded to avoid unbounded growth.
const appliedSteers = new Set<string>();
const APPLIED_STEERS_CAP = 500;

/** A free-text steer → inject into THIS session as a <channel> message (once). */
async function applySteer(m: { id: string; body: string }): Promise<void> {
  if (appliedSteers.has(m.id)) {
    log('steer_dup_skipped', { id: m.id });
    return;
  }
  await mcp.notification({
    method: ChannelMethod.CHANNEL,
    params: { content: m.body, meta: { source_kind: 'imsg_steer', message_id: m.id } },
  });
  appliedSteers.add(m.id);
  if (appliedSteers.size > APPLIED_STEERS_CAP) {
    const oldest = appliedSteers.values().next().value; // Set keeps insertion order
    if (oldest !== undefined) appliedSteers.delete(oldest);
  }
  log('steer_pushed', { id: m.id, len: m.body.length });
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
 * Subscribe to the control plane's SSE event stream and REACT to pushed state
 * changes — no polling. Decisions are applied exactly as before (fail-closed),
 * and free-text steers are injected into the session. Reconnects with a `since`
 * cursor so nothing is missed across drops; the server's 'ping' keeps it warm.
 */
async function subscribeEvents(): Promise<void> {
  await sessionReady; // subscribe under the REAL session id (so steers reach us)
  let since = new Date(0).toISOString();
  for (;;) {
    const token = loadToken();
    if (!token) {
      await sleep(5_000);
      continue;
    }
    try {
      const url =
        deviceApiUrl(DeviceApiRoute.EVENTS) +
        `?sessionId=${encodeURIComponent(SESSION_ID)}&since=${encodeURIComponent(since)}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      });
      if (resp.status === 401) {
        log('events_halt', { reason: '401 device token revoked' });
        await sleep(30_000);
        continue;
      }
      if (!resp.ok || !resp.body) {
        await sleep(5_000);
        continue;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          if (!frame.trim()) continue;
          const { event, data } = parseSSEFrame(frame);
          if (!data) continue;
          try {
            if (event === SseEvent.DECISIONS) {
              const body = JSON.parse(data) as DecisionsResponse;
              const requestIds = new Map<string, string>(Object.entries(body.requestIds ?? {}));
              const decisions = body.decisions ?? [];
              for (const d of decisions) await applyDecision(d, requestIds);
              if (body.since) since = body.since;
              // ACK every decision in the frame (applied or dup-skipped) so the
              // server marks them delivered and stops re-serving. Fire-and-forget
              // so the read loop isn't held on the round-trip.
              if (decisions.length > 0) void ackDecisions(decisions.map((d) => d.attentionId));
            } else if (event === SseEvent.SESSION_MESSAGES) {
              const body = JSON.parse(data) as { messages?: Array<{ id: string; body: string }> };
              const msgs = body.messages ?? [];
              for (const m of msgs) await applySteer(m);
              // ACK every steer in the frame (injected or dup-skipped) so the
              // server sets acked_at and the orchestrator's watcher can confirm
              // delivery to the user. Fire-and-forget (mirrors the decision ACK).
              if (msgs.length > 0) void ackSteers(msgs.map((m) => m.id));
            } else if (event === SseEvent.STATE) {
              // Mirror the control plane's authoritative afk/grant into the local
              // state files the PreToolUse hook reads (guarded: write on change).
              // This is the dashboard/CLI toggle finally reaching the hook.
              const body = JSON.parse(data) as { afk?: string; grant?: string };
              if (isAfkState(body.afk) && body.afk !== readAfk()) {
                writeAfk(body.afk);
                log('afk_synced', { afk: body.afk });
              }
              if (isGrantLevel(body.grant) && body.grant !== readGrant()) {
                writeGrant(body.grant);
                log('grant_synced', { grant: body.grant });
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
      // Stream ended (server cycle / network) — reconnect promptly with the cursor.
    } catch (err) {
      // Include the URL we tried: a stale process resolving the localhost
      // default vs. the baked prod host is the usual cause, and this makes the
      // mismatch obvious at a glance in channel.log.
      log('events_error', {
        url: deviceApiUrl(DeviceApiRoute.EVENTS),
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(5_000);
    }
  }
}

// --- heartbeat: liveness + session touch -------------------------------------
// NOTE: afk/grant are NOT sent up here. The control plane is the source of
// truth: afk/grant flow DOWN to the device via the `state` SSE event (set from
// the dashboard or the CLI's POST /api/device/state), and the heartbeat route
// ignores any afk/grant in the body anyway. Sending them would falsely imply an
// up-sync and risk clobbering the authoritative value.

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
        agent: AgentKind.CLAUDE_CODE,
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
