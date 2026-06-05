/**
 * @imsg/device — local session state (afk / pending).
 *
 * Two tiny flat files under the device dir, mirroring the spike's
 * logs/afk.state. They are the FAST LOCAL path the PreToolUse hook reads on
 * every tool call (the hook must not block on a network round-trip), and the
 * statusline reads for display.
 *
 * Source-of-truth model: the CLI (`imsg afk`) writes afk.state AND POSTs the new
 * value to /api/device/state so the cloud + dashboard stay in sync. The channel
 * server also mirrors a remote afk change down to afk.state so the hook picks it
 * up on the next tool call.
 *
 * Values are validated against the shared enums on read; an unparseable file
 * falls back to the safe default (afk=off).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AfkState, isAfkState } from '@imsg/shared';
import { afkDirtyFile, afkStateFile, pendingStateFile } from './config.ts';

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

/** Whether the local afk toggle is still awaiting cloud confirmation. Defaults to
 *  false (clean) when the flag file is missing/garbage. See afkDirtyFile(). */
export function readAfkDirty(): boolean {
  return readRaw(afkDirtyFile()) === '1';
}

export function writeAfkDirty(dirty: boolean): void {
  writeRaw(afkDirtyFile(), dirty ? '1' : '0');
}

/** Pending-attention count for the statusline (best-effort cache). */
export function readPending(): number {
  const n = Number.parseInt(readRaw(pendingStateFile()), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function writePending(count: number): void {
  writeRaw(pendingStateFile(), String(Math.max(0, count)));
}
