/**
 * @imsg/device — CLI command implementations.
 *
 * One self-contained CLI (invoked as `imsg <cmd>`):
 *   pair <token>        exchange a single-use pairing token for a device_token
 *   afk on|off|toggle   set AFK; mirrors to the cloud via /api/device/state
 *   status              print local pairing + state + outbox summary
 *   statusline          one-line status for the Claude Code status bar
 *
 * pair + state mutations talk to the control plane with the same
 * classification + creds patterns as the channel server. statusline is
 * read-only and never blocks on the network (it's rendered on every prompt).
 */
import { hostname, platform } from 'node:os';
import { AfkState, DeviceApiRoute, isAfkState } from '@imsg/shared';
import { deviceApiUrl, deviceIdFile } from './config.ts';
import { clearToken, ensureDeviceDir, loadToken, saveToken } from './creds.ts';
import { Classification, parseJson, postJson } from './httpclient.ts';
import { rowCount } from './outbox.ts';
import { readAfk, readPending, writeAfk, writeAfkDirty } from './state.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function osLabel(): string {
  const p = platform();
  return p === 'darwin' ? 'macos' : p;
}

function readDeviceId(): string {
  try {
    return readFileSync(deviceIdFile(), 'utf8').trim();
  } catch {
    return '';
  }
}

function writeDeviceId(id: string): void {
  const p = deviceIdFile();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, id, 'utf8');
}

// ----- pair ------------------------------------------------------------------

interface PairResponse {
  deviceId?: string;
  deviceToken?: string;
  // tolerate snake_case from the control plane too
  device_id?: string;
  device_token?: string;
}

export async function pair(pairingToken: string): Promise<number> {
  if (!pairingToken) {
    process.stderr.write('error: pairing token required\n');
    return 2;
  }
  ensureDeviceDir();
  const body = JSON.stringify({
    pairingToken,
    os: osLabel(),
    hostname: hostname(),
  });
  const resp = await postJson(deviceApiUrl(DeviceApiRoute.PAIR), body);

  if (resp.classification === Classification.HALT || resp.status === 401) {
    process.stderr.write('pairing token rejected (request a fresh one from the dashboard)\n');
    return 1;
  }
  if (resp.classification !== Classification.SUCCESS) {
    process.stderr.write(`pair failed: ${resp.error || `status ${resp.status}`}\n`);
    return 1;
  }

  const data = parseJson<PairResponse>(resp);
  const deviceId = data?.deviceId ?? data?.device_id ?? '';
  const deviceToken = data?.deviceToken ?? data?.device_token ?? '';
  if (!deviceId || !deviceToken) {
    process.stderr.write('pair response missing deviceId or deviceToken\n');
    return 1;
  }

  saveToken(deviceToken);
  writeDeviceId(deviceId);
  process.stdout.write(`Paired. deviceId=${deviceId}\n`);
  return 0;
}

// ----- state mutations (afk) -------------------------------------------------

/**
 * POST the local state up so the cloud + dashboard reflect the toggle.
 *
 * DEVICE-WIDE (contract #2): `imsg afk` is a per-device toggle, not a
 * per-session one, so we POST {afk} with NO sessionId. The control plane
 * applies it to ALL of this authenticated device's live sessions and accepts a
 * device-wide update (any 2xx == SUCCESS). The local state file is already
 * the authoritative fast path for the hook; this sync just mirrors to cloud.
 */
async function syncState(afk: AfkState): Promise<boolean> {
  const token = loadToken();
  if (!token) return false; // unpaired: local-only toggle still applied
  const resp = await postJson(
    deviceApiUrl(DeviceApiRoute.STATE),
    JSON.stringify({ afk }),
    { bearer: token },
  );
  if (resp.classification === Classification.SUCCESS) return true;
  if (resp.classification === Classification.HALT) {
    process.stderr.write('warning: device token revoked — re-pair with `imsg pair <token>`\n');
    clearToken();
  } else {
    // Non-fatal: the local state is authoritative for the hook, and the heartbeat
    // will re-assert this toggle up to the cloud while it stays dirty (below).
    process.stderr.write(`warning: could not sync state to cloud (${resp.error || resp.status})\n`);
  }
  return false;
}

export async function afk(arg: string): Promise<number> {
  let next: AfkState;
  if (arg === 'toggle') {
    next = readAfk() === AfkState.ON ? AfkState.OFF : AfkState.ON;
  } else if (isAfkState(arg)) {
    next = arg;
  } else {
    process.stderr.write('usage: imsg afk on|off|toggle\n');
    return 2;
  }
  // Mark dirty BEFORE writing afk: if the process dies mid-toggle, the worst case is
  // a dirty flag with the OLD afk (the heartbeat re-asserts a value the cloud already
  // has — a harmless no-op). The reverse order could leave the NEW afk applied but
  // un-dirty, so a stale server push would silently revert it with no self-heal.
  writeAfkDirty(true);
  writeAfk(next);
  // The flag keeps the heartbeat re-asserting this toggle up (and blocks a stale
  // down-push from reverting it) until the cloud confirms; cleared on a confirmed sync.
  if (await syncState(next)) writeAfkDirty(false);
  process.stdout.write(`afk: ${next}\n`);
  return 0;
}

// ----- status ----------------------------------------------------------------

export function status(): number {
  const deviceId = readDeviceId();
  if (!deviceId || !loadToken()) {
    process.stdout.write('imsg-device: not paired — run `imsg pair <token>`\n');
    return 1;
  }
  process.stdout.write('imsg-device: paired\n');
  process.stdout.write(`  device:   ${deviceId}\n`);
  process.stdout.write(`  afk:      ${readAfk()}\n`);
  process.stdout.write(`  pending:  ${readPending()}\n`);
  process.stdout.write(`  outbox:   ${rowCount()} queued\n`);
  return 0;
}

// ----- statusline ------------------------------------------------------------
// Rendered on every Claude Code prompt; read-only, no network, never throws.

export function statusline(): number {
  try {
    const paired = Boolean(loadToken() && readDeviceId());
    if (!paired) {
      process.stdout.write('📵 imsg: unpaired');
      return 0;
    }
    const afkOn = readAfk() === AfkState.ON;
    const pending = readPending();
    const parts: string[] = [];
    parts.push(afkOn ? '📱 AFK' : '⌨️  here');
    if (pending > 0) parts.push(`⏳${pending}`);
    process.stdout.write(parts.join('  '));
  } catch {
    // Status line must never break the prompt.
    process.stdout.write('');
  }
  return 0;
}
