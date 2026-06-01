#!/usr/bin/env bun
/**
 * @imsg/device — channel MCP server (productized from the validated spike).
 *
 * Implements the official Claude Code Channels contract
 * (code.claude.com/docs/en/channels-reference), reusing the spike's working
 * server VERBATIM where possible:
 *   - capability claude/channel              → push events INTO the session
 *   - capability claude/channel/permission   → relay permission prompts OUT
 *   - a `reply` tool                         → chat bridge OUT (Claude → user)
 *
 * CHANGE FROM THE SPIKE (per the DEVICE PLUGIN contract): the localhost :8799
 * control surface is GONE. Instead this server talks to the CLOUD CONTROL PLANE:
 *   - a permission_request / reply / idle  → an AttentionEvent enqueued in the
 *     durable outbox and POSTed to /api/device/attention (Bearer device_token).
 *   - verdicts + answers + remote grant changes arrive by LONG-POLLING
 *     GET /api/device/decisions; a verdict is relayed back to Claude Code via
 *     the claude/channel/permission notification, an answer is pushed into the
 *     session as a <channel> message, and a grant escalation is written to the
 *     local grant.state so the PreToolUse hook honors it.
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
} from './config.ts';
import { loadToken } from './creds.ts';
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

// Each channel server instance owns one CC session. The session id is supplied
// by the SessionStart-provided env when available, else minted per process.
const SESSION_ID = process.env.IMSG_SESSION_ID ?? randomUUID();
const DEVICE_ID = readDeviceId();

function readDeviceId(): string {
  try {
    return readFileSync(deviceIdFile(), 'utf8').trim();
  } catch {
    return '';
  }
}

// --- MCP server: declare BOTH channel capabilities + the reply tool ---------
// Capabilities + instructions are the EXACT spike wording (neutral, no spike
// branding); only the channel source name changes to the productized id.
const mcp = new Server(
  { name: 'imsg-device', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'You can ask the user questions with the AskUserQuestion tool as normal. IF a hook denies an ' +
      'AskUserQuestion or ExitPlanMode call and tells you to use the `reply` tool, that means the user is ' +
      'away from their keyboard (AFK): follow it — call `reply` with the full question/plan text (all options ' +
      'verbatim) plus a short `qid` tag, then STOP and end your turn (do not exit, do not guess, do not retry ' +
      'the denied tool). Their answer arrives later as a <channel source="imsg-device"> event; match it by qid, ' +
      "treat it as authoritative, and resume. The `reply` tool sends to the user's phone over iMessage.",
  },
);

// reply tool: Claude calls this to send a question/plan/answer OUT to the phone.
// Description is the spike's, verbatim.
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Relay a question or plan summary to the user over iMessage. Call this ONLY when a PreToolUse hook has just instructed you to (it means the user is AFK). Do NOT call it proactively, for status updates, or when you could simply use AskUserQuestion normally.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message to send to the user' },
          qid: {
            type: 'string',
            description: 'Correlation id; echo it so the reply can be matched back',
          },
        },
        required: ['text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const { text, qid } = req.params.arguments as { text: string; qid?: string };
    // A reply is a question/plan attention event. The hook decides kind via the
    // tool it intercepted; here we tag QUESTION (plans also flow as questions to
    // the phone — the user just approves/rejects). The text is sanitized.
    await emitAttention({
      kind: AttentionKind.QUESTION,
      description: sanitizeText(text),
      qid: qid ?? randomUUID(),
    });
    log('reply_out', { qid: qid ?? null, len: text.length });
    return { content: [{ type: 'text', text: 'sent' }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

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
async function applyDecision(d: Decision, requestIdByAttention: Map<string, string>): Promise<void> {
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
              for (const d of body.decisions ?? []) await applyDecision(d, requestIds);
              if (body.since) since = body.since;
            } else if (event === SseEvent.SESSION_MESSAGES) {
              const body = JSON.parse(data) as { messages?: Array<{ id: string; body: string }> };
              for (const m of body.messages ?? []) await applySteer(m);
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
async function heartbeatLoop(): Promise<void> {
  for (;;) {
    const token = loadToken();
    const enabled = token ? await egressEnabled(token).catch(() => true) : false;
    if (token && enabled) {
      const body = JSON.stringify({
        sessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        agent: AgentKind.CLAUDE_CODE,
        hostname: hostname(),
        cwd: process.cwd(),
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
log('connected', { session: SESSION_ID, device: DEVICE_ID, control: deviceApiUrl(DeviceApiRoute.ATTENTION) });

// Fire the background loops; they own their own retry/backoff and never throw
// out (errors are logged + retried) so the MCP stdio loop stays alive.
void subscribeEvents();
void heartbeatLoop();
