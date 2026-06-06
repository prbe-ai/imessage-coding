/**
 * @imsg/device — `imsg codex` launcher: run Codex so it can RECEIVE messages.
 *
 * Plain `codex` runs a standalone TUI whose session lives in-process, unreachable
 * from outside — so the orchestrator's replies have nowhere to land (Codex isn't a
 * Channels client). This launcher instead hosts the session on Codex's app-server
 * and attaches the TUI to it, which is what makes inbound injection possible:
 *
 *   1. start a codex app-server on a FRESH, per-session port (127.0.0.1:<port>),
 *      exporting IMSG_CODEX_APPSERVER_URL so the MCP server it spawns inherits it,
 *   2. exec `codex --remote ws://127.0.0.1:<port> <user args…>` — the interactive
 *      TUI, now a client of THIS session's own app-server.
 *
 * ONE APP-SERVER PER SESSION (not a shared singleton): the app-server spawns a
 * SINGLE imsg-device channel MCP server for the threads it hosts, and that server
 * resolves one session id. A shared app-server across N sessions would give one
 * channel server one id for all of them — mis-attributing every session's
 * message_user/title to a single (wrong) session. A private app-server per launch
 * means one TUI → one loaded thread → the channel server resolves it
 * unambiguously (channel.ts asks thread/loaded/list, see codex-appserver.ts).
 *
 * Pure helpers (port/arg/url construction) are unit-tested; the process
 * orchestration is a thin, side-effecting shell around them.
 */
import { appendFileSync, mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { logDir } from './config.ts';

/**
 * The app-server port for this launch: a fixed override (IMSG_CODEX_APPSERVER_PORT,
 * a valid 1-65535 integer) if set, else null meaning "pick a fresh free port". We
 * do NOT default to a shared port — each session gets its own app-server, so two
 * concurrent `imsg codex` runs never collide on one server. Pure (env injectable).
 */
export function resolveCodexPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.IMSG_CODEX_APPSERVER_PORT?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return null;
}

/** Ask the OS for a free loopback TCP port (bind :0, read it, release). A tiny
 *  TOCTOU window exists before the app-server binds it; negligible on localhost. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no_free_port'))));
    });
  });
}

/** The app-server WebSocket URL the device + the `--remote` TUI both use. */
export function appServerWsUrl(port: number): string {
  return `ws://127.0.0.1:${port}`;
}

/** The app-server's HTTP readiness probe (served alongside the WS listener). */
export function appServerReadyUrl(port: number): string {
  return `http://127.0.0.1:${port}/readyz`;
}

/** Argv (after `codex`) to START the app-server on `port`. */
export function appServerSpawnArgs(port: number): string[] {
  return ['app-server', '--listen', appServerWsUrl(port)];
}

/** Argv (after `codex`) to launch the interactive TUI attached to `port`,
 *  forwarding the user's own args (e.g. `--yolo`, a prompt). */
export function remoteTuiArgs(port: number, passthrough: readonly string[]): string[] {
  return ['--remote', appServerWsUrl(port), ...passthrough];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function launchLog(): string {
  return join(logDir(), 'codex-appserver.log');
}
function note(event: string, data: Record<string, unknown> = {}): void {
  try {
    mkdirSync(logDir(), { recursive: true });
    appendFileSync(launchLog(), JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n');
  } catch {
    /* best-effort */
  }
}

/** True iff the app-server's /readyz answers 200 within `timeoutMs`. */
async function isAppServerUp(port: number, timeoutMs = 1_000): Promise<boolean> {
  try {
    const resp = await fetch(appServerReadyUrl(port), { signal: AbortSignal.timeout(timeoutMs) });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Start this session's own `codex app-server` on `port` and return true once its
 * /readyz answers. The process is unref'd so it outlives this launcher (the TUI
 * attaches to it). IMSG_CODEX_APPSERVER_URL is set in its env so the channel MCP
 * server it spawns inherits the URL — that env is the ONLY URL channel now (no
 * shared url-file, which would be wrong with one app-server per session).
 */
async function startAppServer(port: number, url: string): Promise<boolean> {
  // With a fresh per-session port nothing should be listening; if an override port
  // is already up (e.g. a re-run with IMSG_CODEX_APPSERVER_PORT), reuse it.
  if (await isAppServerUp(port)) {
    note('appserver_reuse', { port });
    return true;
  }
  mkdirSync(logDir(), { recursive: true });
  const fd = openSync(launchLog(), 'a');
  const proc = Bun.spawn(['codex', ...appServerSpawnArgs(port)], {
    env: { ...process.env, IMSG_CODEX_APPSERVER_URL: url },
    stdin: 'ignore',
    stdout: fd,
    stderr: fd,
  });
  proc.unref(); // survive this launcher exiting
  note('appserver_spawned', { port, pid: proc.pid });

  // Poll readiness — the app-server binds + loads config in a second or two.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isAppServerUp(port)) {
      note('appserver_ready', { port });
      return true;
    }
    await sleep(300);
  }
  note('appserver_timeout', { port });
  return false;
}

/**
 * Launch Codex with inbound injection enabled. Forwards `passthrough` (the user's
 * own `codex` args) to the `--remote` TUI. Returns the TUI's exit code. Each launch
 * gets its OWN app-server on a fresh port (unless IMSG_CODEX_APPSERVER_PORT pins
 * one). If the app-server can't be started, falls back to a plain `codex` (so the
 * user is never worse off than today — they just don't get inbound this run).
 */
export async function launchCodex(passthrough: readonly string[]): Promise<number> {
  const port = resolveCodexPort() ?? (await pickFreePort());
  const url = appServerWsUrl(port);

  const up = await startAppServer(port, url);
  let args: string[];
  if (up) {
    args = remoteTuiArgs(port, passthrough);
  } else {
    process.stderr.write(
      'imsg: could not start the Codex app-server — launching plain codex (no inbound this run). See logs/codex-appserver.log\n',
    );
    args = [...passthrough];
  }

  const tui = Bun.spawn(['codex', ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  await tui.exited;
  return tui.exitCode ?? 0;
}
