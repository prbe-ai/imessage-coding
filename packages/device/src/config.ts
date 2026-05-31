/**
 * @imsg/device — configuration: paths, env, control-plane URL.
 *
 * Mirrors prbe-cc-tap-plugin/tap/config.py: every path derives from a single
 * IMSG_DEVICE_DIR (env override) or ~/.claude/plugins/imsg-device/, so the
 * install script, the channel server, the hook, and the CLI all agree on
 * where state lives WITHOUT coordinating. The plugin root (CLAUDE_PLUGIN_ROOT)
 * holds code; the device dir holds mutable state (token, outbox, state files).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DeviceApiRoute } from '@imsg/shared';

export const PLUGIN_NAME = 'imsg-device';

/** Public base URL of the cloud control plane the device talks to. */
const DEFAULT_CONTROL_PLANE_URL = 'https://message.prbe.ai';

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

/** Resolve the control-plane base URL, trailing slash stripped. */
export function controlPlaneUrl(): string {
  const env =
    process.env.IMSG_CONTROL_PLANE_URL ?? process.env.CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL;
  return env.replace(/\/+$/, '');
}

/** Absolute URL for a device API route. */
export function deviceApiUrl(route: DeviceApiRoute): string {
  return controlPlaneUrl() + route;
}

/** Re-export so call sites use the enum, never raw path strings. */
export { DeviceApiRoute };
