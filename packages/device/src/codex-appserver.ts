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
 * thread.sessionId === rollout id`), so once we know the thread id we inject with
 * `turn/start { threadId }`.
 *
 * RESOLVING the thread id: in app-server mode the channel server can't reliably get
 * its session id from the parent-process rollout walk (its parent is the shared
 * app-server, not a per-session codex process), so {@link resolveActiveThreadId}
 * asks the app-server itself via `thread/loaded/list` — authoritative. The launcher
 * gives each codex session its OWN app-server (a unique port), so exactly one thread
 * is loaded and the answer is unambiguous.
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
  THREAD_LOADED_LIST: 'thread/loaded/list',
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

/** The directive prepended to a Codex turn when the user is awaiting a reply. Codex has
 *  no <channel> meta channel (unlike Claude Code's `expect_reply` tag attribute), so the
 *  signal must ride INSIDE the injected text. Bracketed + first so it reads as an
 *  out-of-band note, not part of the user's message. */
export const CODEX_EXPECT_REPLY_DIRECTIVE =
  '[The user is awaiting your reply — when you have an answer, send it back with the ' +
  'message_user tool. They are remote over iMessage and will NOT see your terminal output.]';

/** Build the `turn/start` params for one inbound text reply. When `expectReply` is set,
 *  the expect-reply directive is prepended so the agent knows to answer via message_user;
 *  otherwise the text is injected unchanged (a steer needs no note). Pure (tested). */
export function buildTurnStartParams(
  threadId: string,
  text: string,
  expectReply = false,
): TurnStartParams {
  const body = expectReply ? `${CODEX_EXPECT_REPLY_DIRECTIVE}\n\n${text}` : text;
  return { threadId, input: [{ type: 'text', text: body }] };
}

type LogFn = (event: string, data: Record<string, unknown>) => void;

export interface InjectReplyOpts {
  /** app-server WebSocket URL, e.g. `ws://127.0.0.1:8765`. */
  url: string;
  /** Target thread = the Codex session id (thread.id === sessionId). */
  threadId: string;
  /** The reply text to inject as a new user turn. */
  text: string;
  /** Whether the user is awaiting a reply — prepends a directive to the injected turn so
   *  the agent answers via message_user (Codex has no <channel> meta to carry the flag). */
  expectReply?: boolean;
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
  result?: { turn?: { id?: string }; data?: unknown } & Record<string, unknown>;
  error?: { message?: string; code?: number } & Record<string, unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ResolveThreadOpts {
  /** WS connect timeout. */
  connectMs?: number;
  /** Per-request response timeout. thread/loaded/list answers in ms, so keep this
   *  tight — it caps how long a single wedged call can stall the poll. */
  requestMs?: number;
  /** Total wall-clock budget for the loaded-list poll (the thread may not be
   *  loaded the instant we boot). Bounds the worst case on a hung app-server. */
  totalMs?: number;
  /** Delay between polls. */
  intervalMs?: number;
  log?: LogFn;
}

const RESOLVE_DEFAULTS = {
  connectMs: 4_000,
  requestMs: 2_000,
  totalMs: 10_000,
  intervalMs: 300,
};

/** Pick the single loaded thread id from a `thread/loaded/list` result's `data`
 *  array, or null when it's empty or ambiguous (0 or >1). Pure (tested). With one
 *  app-server per session exactly one thread is loaded, so a single id is the
 *  normal, authoritative answer; 0 (not loaded yet) retries, >1 (shouldn't happen
 *  in the per-session model) falls through to the rollout/handshake path. */
export function singleLoadedThreadId(data: unknown): string | null {
  if (!Array.isArray(data)) return null;
  const ids = data.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return ids.length === 1 ? ids[0]! : null;
}

/**
 * Ask the app-server at `url` for its single loaded thread id (the Codex session
 * id), authoritatively — connect once, initialize, then poll `thread/loaded/list`
 * until exactly one thread is loaded (or attempts run out). Returns the id or null.
 * Never throws. This replaces the unreliable parent-rollout walk for app-server
 * mode: the app-server KNOWS which thread it hosts, the OS process tree does not.
 */
export async function resolveActiveThreadId(url: string, opts: ResolveThreadOpts = {}): Promise<string | null> {
  const o = { ...RESOLVE_DEFAULTS, ...opts };
  const log: LogFn = opts.log ?? (() => {});
  let client: AppServerWs;
  try {
    client = await AppServerWs.connect(url, o.connectMs);
  } catch {
    return null; // app-server not up yet — caller falls back / retries
  }
  try {
    const init = await client.request(AppServerMethod.INITIALIZE, { clientInfo: CLIENT_INFO }, o.requestMs);
    if (init.error) return null;
    client.notify(AppServerMethod.INITIALIZED);
    // Poll thread/loaded/list until one thread is loaded or the budget runs out.
    // Bounded by wall-clock (totalMs), NOT a fixed attempt count, so a hung-but-
    // connected app-server can't stack per-call timeouts into a multi-minute stall.
    const deadline = Date.now() + o.totalMs;
    do {
      const resp = await client.request(AppServerMethod.THREAD_LOADED_LIST, {}, o.requestMs);
      const id = singleLoadedThreadId(resp.result?.data);
      if (id) {
        log('codex_thread_from_appserver', { thread: id });
        return id;
      }
      await sleep(o.intervalMs);
    } while (Date.now() < deadline);
    return null;
  } finally {
    client.close();
  }
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
      buildTurnStartParams(o.threadId, o.text, o.expectReply),
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
