/**
 * @imsg/device — `imsg codex` launcher: run Codex so it can RECEIVE messages.
 *
 * Plain `codex` runs a standalone TUI whose session lives in-process, unreachable
 * from outside — so the orchestrator's replies have nowhere to land (Codex isn't a
 * Channels client). This launcher instead hosts the session on Codex's app-server
 * and attaches the TUI to it, which is what makes inbound injection possible:
 *
 *   1. ensure a singleton `codex app-server --listen ws://127.0.0.1:<port>` is up
 *      (export IMSG_CODEX_APPSERVER_URL so the MCP servers it spawns inherit it),
 *   2. write that URL to codexAppServerUrlFile() (belt-and-suspenders for a child
 *      that didn't inherit the env),
 *   3. exec `codex --remote ws://127.0.0.1:<port> <user args…>` — the interactive
 *      TUI, now a client of the app-server.
 *
 * The channel MCP server (spawned by the app-server for the session) then injects
 * each inbound reply as a `turn/start` over that same WS (see codex-appserver.ts).
 *
 * Pure helpers (port/arg/url construction) are unit-tested; the process
 * orchestration is a thin, side-effecting shell around them.
 */
import { appendFileSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexAppServerUrlFile, logDir } from './config.ts';

/** Default loopback port for the per-machine app-server. Overridable via
 *  IMSG_CODEX_APPSERVER_PORT for the rare conflict. */
export const DEFAULT_CODEX_APPSERVER_PORT = 8765;

/** Resolve the app-server port: IMSG_CODEX_APPSERVER_PORT if a valid 1-65535
 *  integer, else the default. Pure (env injectable) for testing. */
export function resolveCodexPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.IMSG_CODEX_APPSERVER_PORT?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return DEFAULT_CODEX_APPSERVER_PORT;
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
 * Ensure a `codex app-server` is listening on `port`, starting a detached one if
 * not. Returns true once /readyz answers. The spawned process is unref'd so it
 * outlives this launcher (and a later `imsg codex` reuses it) — a per-machine
 * singleton. Idempotent: a second caller finds it already up.
 */
async function ensureAppServer(port: number, url: string): Promise<boolean> {
  if (await isAppServerUp(port)) {
    note('appserver_reuse', { port });
    return true;
  }
  mkdirSync(logDir(), { recursive: true });
  const fd = openSync(launchLog(), 'a');
  const proc = Bun.spawn(['codex', ...appServerSpawnArgs(port)], {
    // IMSG_CODEX_APPSERVER_URL is inherited by the MCP servers the app-server
    // spawns, so the channel server resolves the injection target without a file.
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

/** Persist the live URL so a channel server that didn't inherit the env finds it. */
function writeUrlFile(url: string): void {
  try {
    const path = codexAppServerUrlFile();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, url, 'utf8');
  } catch {
    /* best-effort — the inherited env var is the primary channel */
  }
}

/**
 * Launch Codex with inbound injection enabled. Forwards `passthrough` (the user's
 * own `codex` args) to the `--remote` TUI. Returns the TUI's exit code. If the
 * app-server can't be started, falls back to a plain `codex` (so the user is never
 * worse off than today — they just don't get inbound this run).
 */
export async function launchCodex(passthrough: readonly string[]): Promise<number> {
  const port = resolveCodexPort();
  const url = appServerWsUrl(port);

  const up = await ensureAppServer(port, url);
  let args: string[];
  if (up) {
    writeUrlFile(url);
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
