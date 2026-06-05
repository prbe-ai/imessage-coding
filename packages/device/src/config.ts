/**
 * @imsg/device — configuration: paths, env, control-plane URL.
 *
 * Every path derives from a single
 * IMSG_DEVICE_DIR (env override) or the neutral, agent-agnostic ~/.imsg/, so the
 * install script, the channel server, the hook, and the CLI all agree on where
 * state lives WITHOUT coordinating. The neutral folder (NOT ~/.claude/...) lets
 * Claude Code AND other agents (e.g. Codex) share one machine-wide AFK switch +
 * one logs/sessions location. The plugin root (CLAUDE_PLUGIN_ROOT) holds code;
 * the device dir holds mutable state (token, outbox, logs, state files).
 *
 * State written by pre-0.1.7 versions under ~/.claude/plugins/imsg-device/ is
 * relocated on first run by migrateLegacyDeviceDir() (non-destructive copy).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentKind, DeviceApiRoute, isAgentKind } from '@imsg/shared';

export const PLUGIN_NAME = 'imsg-device';

/** Public base URL of the cloud control plane the device talks to. Local-dev
 *  default; set IMSG_CONTROL_PLANE_URL to your deployed control-plane host. */
const DEFAULT_CONTROL_PLANE_URL = 'http://localhost:8080';

/** Heartbeat cadence the channel server posts session liveness on. Short so the
 *  server's staleness reaper (SESSION_STALE_SECONDS) can drop dead sessions fast. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Killswitch poll TTL (fail-OPEN disable check). Matches tap-plugin's 300s. */
export const KILLSWITCH_TTL_MS = 300_000;

/** Default neutral, agent-agnostic state dir (shared by Claude Code, Codex, …). */
export function defaultDeviceDir(): string {
  return join(homedir(), '.imsg');
}

/** Pre-0.1.7 location, nested under Claude Code's plugin dir. We migrate AWAY from
 *  this so the folder is no longer Claude-Code-specific (see migrateLegacyDeviceDir). */
export function legacyDeviceDir(): string {
  return join(homedir(), '.claude', 'plugins', PLUGIN_NAME);
}

/**
 * Mutable-state directory. IMSG_DEVICE_DIR overrides; otherwise the neutral
 * ~/.imsg/. NOTE: deliberately separate from CLAUDE_PLUGIN_ROOT (code) so a
 * marketplace reinstall never clobbers the token.
 */
export function deviceDir(): string {
  const env = process.env.IMSG_DEVICE_DIR;
  if (env && env.trim()) return env.trim();
  return defaultDeviceDir();
}

/** Sentinel written into the new dir once the one-time legacy relocation ran. */
const MIGRATION_SENTINEL = '.migrated';

/**
 * Pure decision: should we relocate the legacy dir's contents into `target`?
 * Only the DEFAULT relocation (~/.claude/plugins/imsg-device → ~/.imsg) is
 * automatic — an explicit custom IMSG_DEVICE_DIR is honored as-is and never
 * auto-populated from legacy. Skips when already migrated (sentinel present) or
 * there is nothing to migrate. Pure (inputs injected) so it's unit-testable.
 */
export function shouldMigrateLegacy(opts: {
  target: string;
  newDefault: string;
  legacyDir: string;
  targetHasSentinel: boolean;
  legacyExists: boolean;
}): boolean {
  const { target, newDefault, legacyDir, targetHasSentinel, legacyExists } = opts;
  if (target !== newDefault) return false; // explicit custom dir — leave it alone
  if (target === legacyDir) return false; // nothing to relocate
  if (targetHasSentinel) return false; // already done
  return legacyExists;
}

let _migrated = false;

/**
 * NON-DESTRUCTIVE copy of `legacyDir`'s contents into `target`, then stamp
 * `sentinelPath`. force:false + errorOnExist:false → fill in what's missing,
 * NEVER clobber state already in the new dir (a partial prior run, or fresh state
 * written first). Returns true iff it ran without error. Never throws. Split out
 * from path/env resolution so it's exercisable with explicit sandbox paths.
 *
 * The user runs many concurrent CC sessions, so the MCP server + several hooks
 * can race this on first upgrade (the sentinel is written last). That's tolerated:
 * per-file copy is idempotent and force:false guarantees no writer clobbers
 * another's bytes (or fresh state), so the merged result is identical either way.
 */
export function relocateLegacyState(legacyDir: string, target: string, sentinelPath: string): boolean {
  try {
    mkdirSync(target, { recursive: true });
    cpSync(legacyDir, target, { recursive: true, force: false, errorOnExist: false });
    writeFileSync(sentinelPath, `migrated from ${legacyDir} at ${new Date().toISOString()}\n`, 'utf8');
    return true;
  } catch {
    return false; // best-effort — legacy dir is untouched; a later process retries
  }
}

/**
 * One-time, idempotent, NON-DESTRUCTIVE relocation of pre-0.1.7 state from
 * ~/.claude/plugins/imsg-device/ into the neutral ~/.imsg/. Copies (never moves)
 * so the legacy dir stays intact and recovery is trivial. Memoized per process —
 * a migration failure must never crash a hook or the MCP server (the token is
 * also in the macOS keychain, so a missed token file self-heals). Call this early
 * at every executable entrypoint, before any state read.
 */
export function migrateLegacyDeviceDir(): void {
  if (_migrated) return;
  _migrated = true; // one attempt per process, whatever the outcome
  const target = deviceDir();
  const legacyDir = legacyDeviceDir();
  const sentinel = join(target, MIGRATION_SENTINEL);
  let shouldRun = false;
  try {
    shouldRun = shouldMigrateLegacy({
      target,
      newDefault: defaultDeviceDir(),
      legacyDir,
      targetHasSentinel: existsSync(sentinel),
      legacyExists: existsSync(legacyDir),
    });
  } catch {
    return; // a stat failure must not crash the caller
  }
  if (shouldRun) relocateLegacyState(legacyDir, target, sentinel);
}

/** Plugin code root (set by Claude Code when invoking hooks / MCP server). */
export function pluginRoot(): string {
  return process.env.CLAUDE_PLUGIN_ROOT ?? deviceDir();
}

export function tokenFile(): string {
  return join(deviceDir(), '.token');
}

export function configFile(): string {
  return join(deviceDir(), '.config.json');
}

export function logDir(): string {
  return join(deviceDir(), 'logs');
}

export function outboxFile(): string {
  return join(deviceDir(), 'outbox.jsonl');
}

/** Local AFK state file (on|off). Read by the hook + statusline; written by CLI. */
export function afkStateFile(): string {
  return join(deviceDir(), 'afk.state');
}

/** Local AFK "dirty" flag. Set when `imsg afk` toggles but the cloud POST may not
 *  have landed; cleared once a heartbeat confirms the server adopted the value.
 *  While dirty: (a) the heartbeat re-asserts afk up (so a lost POST self-heals),
 *  and (b) a down-pushed afk is NOT applied — so a stale server value can never
 *  revert a fresh local toggle whose POST was dropped. */
export function afkDirtyFile(): string {
  return join(deviceDir(), 'afk.dirty');
}

/** Cached pending-attention count for the statusline (written by channel server). */
export function pendingStateFile(): string {
  return join(deviceDir(), 'pending.state');
}

/** Cached device_id for status (written at pair time). */
export function deviceIdFile(): string {
  return join(deviceDir(), '.device_id');
}

/** Killswitch-disabled sentinel: presence disables egress (fail-OPEN to disable). */
export function disabledFile(): string {
  return join(deviceDir(), '.disabled');
}

// --- per-session tap daemon state (one set per Claude Code session) -----------
// All keyed by CC's real session id, shared between the SessionStart/SessionEnd
// hooks (which spawn/stop the daemon) and the daemon itself.

/** Directory holding the per-session tap state files. */
export function sessionsDir(): string {
  return join(deviceDir(), 'sessions');
}

/** Persisted tail cursor (byte offset + last line number) for a session. */
export function sessionCursorFile(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.cursor.json`);
}

/** Durable per-session activity outbox (JSONL of un-shipped batches). */
export function sessionOutboxFile(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.activity.jsonl`);
}

/** Shutdown sentinel: presence tells the daemon to exit (set by SessionEnd). */
export function sessionShutdownFile(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.shutdown`);
}

/** PID of the spawned daemon (written by SessionStart, read by SessionEnd). */
export function sessionPidFile(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.pid`);
}

/**
 * Liveness sentinel: the tap daemon touches it every loop iteration. ensureTap
 * (tap-spawn.ts) treats a tap as alive iff this file's mtime is recent — a
 * FRESHNESS check, not a bare pid check, so a crashed tap (or a pid recycled by an
 * unrelated process) reads as stale and gets respawned by the next hook.
 */
export function sessionAliveFile(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.alive`);
}

/**
 * Captured session title (the first user message, sanitized + truncated). The
 * tap daemon writes it once from the transcript; the channel MCP server reads it
 * and forwards it on the heartbeat. A plain local file — NOT egress — so it's
 * independent of the tap's AFK ship-gate (the title rides the always-on
 * heartbeat as session metadata, like cwd).
 */
export function sessionTitleFile(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.title`);
}

/** Canonical UUID shape (CC session ids are UUIDs; sessions.id is a UUID column). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Eager (synchronous) session-id source, in precedence order:
 *   1. IMSG_SESSION_ID        — explicit override (tests / manual runs), honored as-is.
 *   2. CLAUDE_CODE_SESSION_ID — CC-native (≥2.1.160): the real session id handed
 *      to the plugin's MCP server. This is what disambiguates concurrent sessions
 *      sharing one project dir — each server reads its OWN id. Accepted ONLY if it's
 *      UUID-shaped — a blank/garbage/shell-polluted value falls through so the caller
 *      can recover via the SessionStart handshake (same CC, real id) instead of
 *      stranding the session on an id the control plane will reject.
 * Returns null when neither yields a usable id, so the caller falls back to the
 * handshake (older CC) and finally a random id. Pure (env injectable) for testing.
 */
export function pickEagerSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.IMSG_SESSION_ID?.trim();
  if (override) return override;
  const native = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (native && UUID_RE.test(native)) return native;
  return null;
}

/**
 * Which coding agent this device session is running, for the heartbeat / session
 * row. Read from IMSG_AGENT_KIND (set by the Codex launcher; unset under Claude
 * Code) and validated against AgentKind, so an unknown / garbage value can't
 * mislabel a session. Defaults to AgentKind.CLAUDE_CODE — the byte-for-byte prior
 * behavior — when unset or invalid. Pure (env injectable) for testing.
 */
export function agentKind(env: NodeJS.ProcessEnv = process.env): AgentKind {
  const v = env.IMSG_AGENT_KIND?.trim();
  return isAgentKind(v) ? v : AgentKind.CLAUDE_CODE;
}

/**
 * True iff `dir` sits inside Codex's plugin cache (`…/.codex/plugins/…`) or a
 * marketplace clone (`…/codex/marketplaces/…`) — i.e. one of Codex's OWN
 * throwaway sessions for installing/validating a plugin, which carry no user
 * turn. Both the SessionStart tap AND the long-lived MCP server's heartbeat key a
 * dashboard `sessions` row off the project dir, so each skips its work for such a
 * cwd — otherwise these register a titleless row labelled by the plugin's version
 * folder (e.g. ".../imsg-device/0.1.11"). Matches a `codex/{plugins,marketplaces}/`
 * path segment (with or without the leading dot), so an unrelated dir that merely
 * contains the word "codex" (e.g. `…/mycodex-app`) does NOT match.
 */
export function isPluginHousekeepingDir(dir: string): boolean {
  return /(?:^|\/)\.?codex\/(?:plugins|marketplaces)(?:\/|$)/.test(dir);
}

/**
 * Build-baked config, written into the plugin ROOT (next to package.json) at
 * build time by apps/dashboard/scripts/copy-install-script.mjs. This is how the
 * long-lived MCP server + CLI learn the control-plane URL: Claude Code spawns
 * them with NO env, so without a baked value `controlPlaneUrl()` would fall back
 * to localhost. Absent in local-checkout / dev installs (then env or the
 * localhost default applies).
 */
interface BuildConfig {
  controlPlaneUrl?: string;
  /** app-server WebSocket URL for Codex inbound injection (see codexAppServerUrl).
   *  Normally written at LAUNCH time by `imsg codex`, not baked — present here so a
   *  fixed-port deployment could bake it. */
  codexAppServerUrl?: string;
}

let _buildConfig: BuildConfig | null | undefined;

/** Read + memoize `<pluginRoot>/build-config.json`. Located relative to THIS
 *  file (src/config.ts -> ../build-config.json) so it resolves identically from
 *  the marketplace dir or Claude Code's plugin cache, regardless of cwd or
 *  whether CLAUDE_PLUGIN_ROOT is set. NEVER throws: missing or malformed -> null
 *  (a throw here would crash-loop the MCP server on every start). */
export function buildConfig(): BuildConfig | null {
  if (_buildConfig !== undefined) return _buildConfig;
  try {
    const path = join(import.meta.dir, '..', 'build-config.json');
    _buildConfig = JSON.parse(readFileSync(path, 'utf8')) as BuildConfig;
  } catch {
    _buildConfig = null;
  }
  return _buildConfig;
}

/**
 * Pure control-plane URL resolution (no filesystem / process access — unit
 * tested directly). Precedence: explicit env override > build-baked config >
 * local-dev default. Empty / whitespace-only values are treated as unset so an
 * accidental `CONTROL_PLANE_URL=""` at build time can't shadow the default.
 */
export function resolveControlPlaneUrl(
  env: Record<string, string | undefined>,
  baked: BuildConfig | null,
): string {
  const candidates = [env.IMSG_CONTROL_PLANE_URL, env.CONTROL_PLANE_URL, baked?.controlPlaneUrl];
  const found = candidates.find((v) => typeof v === 'string' && v.trim().length > 0);
  return (found ?? DEFAULT_CONTROL_PLANE_URL).trim().replace(/\/+$/, '');
}

/** Resolve the control-plane base URL, trailing slash stripped. */
export function controlPlaneUrl(): string {
  return resolveControlPlaneUrl(process.env, buildConfig());
}

/** Absolute URL for a device API route. */
export function deviceApiUrl(route: DeviceApiRoute): string {
  return controlPlaneUrl() + route;
}

// --- Codex app-server URL (inbound injection target) -------------------------
// Codex can't receive a `claude/channel` notification (it isn't a Channels
// client), so for Codex the channel server injects inbound replies via the
// app-server's `turn/start` over a WebSocket (see codex-appserver.ts). This URL
// names that app-server. It's set ONLY when the user launches via `imsg codex`,
// which hosts `codex app-server --listen ws://…` and points the TUI at it; the
// launcher both exports IMSG_CODEX_APPSERVER_URL (inherited by the MCP servers the
// app-server spawns) AND writes it to a file (codexAppServerUrlFile) so a child
// that didn't inherit the env still finds it. Empty = feature OFF (plain `codex`),
// so the dropped-notification path is unchanged for non-launcher sessions.

/** Launcher-written file holding the live app-server WS URL (one per machine). */
export function codexAppServerUrlFile(): string {
  return join(deviceDir(), 'codex-appserver.url');
}

/**
 * Pure resolution (no I/O — unit tested). Precedence: explicit env override >
 * launcher-written file value > build-baked config. Empty / whitespace-only
 * values are treated as unset (so an accidental empty env/file can't shadow a
 * later candidate), and a trailing slash is stripped. Returns '' when none is
 * configured — the OFF signal the channel server gates on.
 */
export function resolveCodexAppServerUrl(
  env: Record<string, string | undefined>,
  fileValue: string | undefined,
  baked: BuildConfig | null,
): string {
  const candidates = [env.IMSG_CODEX_APPSERVER_URL, fileValue, baked?.codexAppServerUrl];
  const found = candidates.find((v) => typeof v === 'string' && v.trim().length > 0);
  return found ? found.trim().replace(/\/+$/, '') : '';
}

/** Resolve the Codex app-server WS URL, or '' if the feature is not configured. */
export function codexAppServerUrl(): string {
  let fileValue: string | undefined;
  try {
    fileValue = readFileSync(codexAppServerUrlFile(), 'utf8');
  } catch {
    fileValue = undefined; // no launcher file → fall through to env/baked
  }
  return resolveCodexAppServerUrl(process.env, fileValue, buildConfig());
}

/** Re-export so call sites use the enum, never raw path strings. */
export { DeviceApiRoute };
