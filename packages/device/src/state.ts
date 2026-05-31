/**
 * @imsg/device — local session state (afk / grant / pending).
 *
 * Three tiny flat files under the device dir, mirroring the spike's
 * logs/afk.state + logs/grant.state. They are the FAST LOCAL path the
 * PreToolUse hook reads on every tool call (the hook must not block on a
 * network round-trip), and the statusline reads for display.
 *
 * Source-of-truth model:
 *   - The CLI (`imsg afk` / `imsg grant`) writes these AND POSTs the new value
 *     to /api/device/state so the cloud + dashboard stay in sync.
 *   - The channel server, when it learns of a remote grant change (e.g. a plan
 *     approved from the phone → grant edits/full), writes them locally so the
 *     hook picks the change up on the next tool call.
 *
 * Values are validated against the shared enums on read; an unparseable file
 * falls back to the safe default (afk=off, grant=off) — fail-closed for grant.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AfkState, GrantLevel, isAfkState, isGrantLevel } from '@imsg/shared';
import { afkStateFile, grantStateFile, pendingStateFile } from './config.ts';

function readRaw(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function writeRaw(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

/** Current AFK state; defaults to OFF (at-keyboard, native prompts). */
export function readAfk(): AfkState {
  const v = readRaw(afkStateFile());
  return isAfkState(v) ? v : AfkState.OFF;
}

export function writeAfk(state: AfkState): void {
  writeRaw(afkStateFile(), state);
}

/** Current grant level; defaults to OFF (no session auto-approve) — fail-closed. */
export function readGrant(): GrantLevel {
  const v = readRaw(grantStateFile());
  return isGrantLevel(v) ? v : GrantLevel.OFF;
}

export function writeGrant(level: GrantLevel): void {
  writeRaw(grantStateFile(), level);
}

/** Pending-attention count for the statusline (best-effort cache). */
export function readPending(): number {
  const n = Number.parseInt(readRaw(pendingStateFile()), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function writePending(count: number): void {
  writeRaw(pendingStateFile(), String(Math.max(0, count)));
}
