/**
 * @imsg/device — configuration: paths, env, control-plane URL.
 *
 * Every path derives from a single
 * IMSG_DEVICE_DIR (env override) or ~/.claude/plugins/imsg-device/, so the
 * install script, the channel server, the hook, and the CLI all agree on
 * where state lives WITHOUT coordinating. The plugin root (CLAUDE_PLUGIN_ROOT)
 * holds code; the device dir holds mutable state (token, outbox, state files).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DeviceApiRoute } from '@imsg/shared';

export const PLUGIN_NAME = 'imsg-device';

/** Public base URL of the cloud control plane the device talks to. Local-dev
 *  default; set IMSG_CONTROL_PLANE_URL to your deployed control-plane host. */
const DEFAULT_CONTROL_PLANE_URL = 'http://localhost:8080';

/** Long-poll timeout for GET /api/device/decisions, kept under the server's ~25s. */
export const DECISIONS_LONG_POLL_TIMEOUT_MS = 30_000;

/** Heartbeat cadence the channel server posts session liveness on. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** Killswitch poll TTL (fail-OPEN disable check). Matches tap-plugin's 300s. */
export const KILLSWITCH_TTL_MS = 300_000;

/**
 * Mutable-state directory. IMSG_DEVICE_DIR overrides; otherwise the canonical
 * per-user location under ~/.claude/plugins. NOTE: deliberately separate from
 * CLAUDE_PLUGIN_ROOT (code) so a marketplace reinstall never clobbers the token.
 */
export function deviceDir(): string {
  const env = process.env.IMSG_DEVICE_DIR;
  if (env && env.trim()) return env.trim();
  return join(homedir(), '.claude', 'plugins', PLUGIN_NAME);
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

/** Local grant state file (off|edits|full). */
export function grantStateFile(): string {
  return join(deviceDir(), 'grant.state');
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
 * Build-baked config, written into the plugin ROOT (next to package.json) at
 * build time by apps/dashboard/scripts/copy-install-script.mjs. This is how the
 * long-lived MCP server + CLI learn the control-plane URL: Claude Code spawns
 * them with NO env, so without a baked value `controlPlaneUrl()` would fall back
 * to localhost. Absent in local-checkout / dev installs (then env or the
 * localhost default applies).
 */
interface BuildConfig {
  controlPlaneUrl?: string;
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

/** Re-export so call sites use the enum, never raw path strings. */
export { DeviceApiRoute };
