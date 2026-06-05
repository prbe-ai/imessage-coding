/**
 * @imsg/device — Codex app-server inbound injector.
 *
 * WHY THIS EXISTS: a reply/steer from the orchestrator reaches Claude Code by a
 * `claude/channel` MCP notification (channel.ts applyInbox) — the Claude Code
 * "Channels" client contract. Codex does NOT implement that contract, so the
 * notification is silently dropped and the message never enters the Codex
 * conversation: Codex could SEND (message_user is an ordinary MCP tool) but never
 * RECEIVE. This module is the Codex equivalent of the channel injection.
 *
 * HOW: Codex 0.137.0 ships an app-server (`codex app-server --listen ws://…`) that
 * hosts sessions as "threads" and accepts a JSON-RPC `turn/start` from ANY client
 * over the WebSocket — verified end-to-end: a second WS connection can inject a
 * user turn into a thread a first connection (the user's `--remote` TUI) owns, and
 * the owner receives the whole turn live (reasoning, tool calls, streamed reply).
 * The app-server's thread id EQUALS the Codex session id (`thread.id ===
 * thread.sessionId === rollout id`), which is exactly the SESSION_ID the channel
 * server already resolves from the parent codex rollout (codex-session.ts). So we
 * inject with `turn/start { threadId: SESSION_ID }` — no discovery needed.
 *
 * Gated by codexAppServerUrl() (config.ts): only set when the user launches via
 * `imsg codex`, which hosts the app-server and points the TUI at it. With no URL
 * the channel server keeps the old (dropped) notification path, so plain
 * `codex` users are byte-for-byte unaffected.
 *
 * Runs under Bun (the channel server's runtime), so `WebSocket` is a global. Never
 * throws out: returns {ok:false} on any failure so the caller leaves the inbox row
 * un-ACKed and the control plane re-serves it on the next SSE flush.
 */

/** app-server JSON-RPC method names (enum, never bare strings at call sites). */
export const AppServerMethod = {
  INITIALIZE: 'initialize',
  INITIALIZED: 'initialized',
  TURN_START: 'turn/start',
} as const;

/** JSON-RPC version every frame carries. */
const JSONRPC_VERSION = '2.0';

/** Client identity the app-server records as userAgent. A STABLE protocol-client
 *  label — intentionally NOT the plugin version, so it never drifts on a release
 *  bump (cosmetic metadata only; the app-server just logs it). */
const CLIENT_INFO = { name: 'imsg-device', version: '1' } as const;

/** One text item of `UserInput` — the only kind we inject (a phone message). */
export interface TextUserInput {
  type: 'text';
  text: string;
}

/** Params for `turn/start` (TurnStartParams: requires threadId + input). */
export interface TurnStartParams {
  threadId: string;
  input: TextUserInput[];
}

/** Build the `turn/start` params for one inbound text reply. Pure (tested). */
export function buildTurnStartParams(threadId: string, text: string): TurnStartParams {
  return { threadId, input: [{ type: 'text', text }] };
}

type LogFn = (event: string, data: Record<string, unknown>) => void;

export interface InjectReplyOpts {
  /** app-server WebSocket URL, e.g. `ws://127.0.0.1:8765`. */
  url: string;
  /** Target thread = the Codex session id (thread.id === sessionId). */
  threadId: string;
  /** The reply text to inject as a new user turn. */
  text: string;
  /** WS connect timeout. */
  connectMs?: number;
  /** Per-request (initialize / turn/start) response timeout. */
  requestMs?: number;
  /** Optional structured logger (channel.ts passes its `log`). */
  log?: LogFn;
}

export interface InjectResult {
  ok: boolean;
  /** Short machine reason for logs (e.g. 'connect_failed', 'turn_start_failed'). */
  reason?: string;
  /** The accepted turn id, when ok. */
  turnId?: string;
}

const DEFAULTS = {
  connectMs: 4_000,
  requestMs: 20_000,
};

/**
 * Minimal JSON-RPC-over-WebSocket client for one injection, then close. Each
 * request is newline-free (one WS text frame per message). Pending requests are
 * keyed by id; notifications (no id) are ignored — we only need the turn/start
 * ack, not the streamed turn (that flows to the user's TUI + via message_user).
 */
class AppServerWs {
  private ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, (msg: AppServerResponse) => void>();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener('message', (e: MessageEvent) => this.onMessage(e));
  }

  static connect(url: string, connectMs: number): Promise<AppServerWs> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('connect_timeout'));
      }, connectMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new AppServerWs(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('connect_error'));
      });
    });
  }

  private onMessage(e: MessageEvent): void {
    let msg: AppServerResponse;
    try {
      msg = JSON.parse(String(e.data)) as AppServerResponse;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
    // Server notifications (turn/started, item/completed, …) carry no id we sent;
    // ignore them — the turn streams to the user's TUI, not to us.
  }

  notify(method: string): void {
    this.ws.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, method }));
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<AppServerResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, error: { message: 'request_timeout' } });
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params }));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

interface AppServerResponse {
  id?: number;
  result?: { turn?: { id?: string } } & Record<string, unknown>;
  error?: { message?: string; code?: number } & Record<string, unknown>;
}

/**
 * Inject `text` as a new user turn into the Codex session `threadId` on the
 * app-server at `url`. Connects a fresh WS, does the initialize handshake, calls
 * turn/start once, and closes. Never throws — returns {ok:false} on any failure
 * so the caller leaves the inbox row un-ACked and the control plane re-serves it
 * (the re-serve IS the retry; no in-injector retry needed).
 *
 * Verified against codex 0.137.0: turn/start is ACCEPTED even when a turn is
 * already running — the app-server queues it as the next turn rather than
 * rejecting it — so there is no active-turn error to handle here. (The protocol's
 * turn/steer is what STEERS an in-flight turn; injecting a phone reply as its own
 * follow-up turn is the behavior we want for the AFK case, where the agent is
 * almost always idle/stopped when the reply arrives.)
 */
export async function injectReply(opts: InjectReplyOpts): Promise<InjectResult> {
  const o = { ...DEFAULTS, ...opts };
  const log: LogFn = opts.log ?? (() => {});
  let client: AppServerWs;
  try {
    client = await AppServerWs.connect(o.url, o.connectMs);
  } catch (err) {
    log('codex_appserver_connect_failed', {
      url: o.url,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: 'connect_failed' };
  }

  try {
    const init = await client.request(AppServerMethod.INITIALIZE, { clientInfo: CLIENT_INFO }, o.requestMs);
    if (init.error) {
      log('codex_appserver_init_failed', { error: init.error.message });
      return { ok: false, reason: 'init_failed' };
    }
    client.notify(AppServerMethod.INITIALIZED);

    const resp = await client.request(
      AppServerMethod.TURN_START,
      buildTurnStartParams(o.threadId, o.text),
      o.requestMs,
    );
    if (resp.error) {
      log('codex_turn_start_failed', { threadId: o.threadId, error: resp.error.message });
      return { ok: false, reason: 'turn_start_failed' };
    }
    const turnId = resp.result?.turn?.id;
    log('codex_turn_injected', { threadId: o.threadId, turnId });
    return { ok: true, turnId };
  } finally {
    client.close();
  }
}
