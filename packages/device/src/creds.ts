/**
 * @imsg/device — device_token credential storage.
 *
 * Bearer device_token resolution + persistence, with macOS Keychain as the
 * primary store and a 0600 file as the fallback (keychain + file creds
 * pattern).
 *
 * Read order:  env IMSG_DEVICE_TOKEN  >  keychain  >  ${deviceDir}/.token
 * Write:       keychain (best-effort) AND the 0600 file (always), so a keychain
 *              denial (e.g. headless / Linux) never strands the device.
 *
 * The token is NEVER logged. Callers that surface errors must not echo it.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deviceDir, tokenFile } from './config.ts';

const KEYCHAIN_SERVICE = 'imsg-device';
const KEYCHAIN_ACCOUNT = 'device-token';

function isMac(): boolean {
  return process.platform === 'darwin';
}

/** Read the token from the macOS Keychain. Returns null on any failure. */
function readKeychain(): string | null {
  if (!isMac()) return null;
  try {
    const r = spawnSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { encoding: 'utf8', timeout: 5000 },
    );
    if (r.status === 0 && typeof r.stdout === 'string') {
      const t = r.stdout.trim();
      return t || null;
    }
  } catch {
    /* fall through to file */
  }
  return null;
}

/** Best-effort keychain write. Silent on failure (file fallback always runs). */
function writeKeychain(token: string): void {
  if (!isMac()) return;
  try {
    // -U updates if present; -w value passed inline (only ever a server-minted
    // opaque token, never a user secret on the command line in practice).
    spawnSync(
      'security',
      [
        'add-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        KEYCHAIN_ACCOUNT,
        '-U',
        '-w',
        token,
      ],
      { timeout: 5000 },
    );
  } catch {
    /* keychain optional; the 0600 file is the source of truth fallback */
  }
}

function readFile(): string | null {
  try {
    const t = readFileSync(tokenFile(), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Atomic 0600 write of the token file (tmp + rename). */
function writeFile(token: string): void {
  const p = tokenFile();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, token, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* mode already set at open on most platforms */
  }
  renameSync(tmp, p);
}

/**
 * Load the device bearer token. env > keychain > file. Returns null if unpaired.
 */
export function loadToken(): string | null {
  const env = process.env.IMSG_DEVICE_TOKEN;
  if (env && env.trim()) return env.trim();
  return readKeychain() ?? readFile();
}

/** Persist a freshly-minted token to BOTH keychain (best-effort) and file. */
export function saveToken(token: string): void {
  writeFile(token);
  writeKeychain(token);
}

/** Remove the local token (used on 401 halt / revoke). Best-effort. */
export function clearToken(): void {
  try {
    writeFile('');
  } catch {
    /* ignore */
  }
  if (isMac()) {
    try {
      spawnSync('security', [
        'delete-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        KEYCHAIN_ACCOUNT,
      ]);
    } catch {
      /* ignore */
    }
  }
}

/** Ensure the device state dir exists (callers that write state rely on this). */
export function ensureDeviceDir(): void {
  mkdirSync(deviceDir(), { recursive: true });
}
