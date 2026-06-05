/**
 * @imsg/device — pure AFK sync (dirty-flag) decisions.
 *
 * channel.ts can't be imported in tests (it starts the MCP server on import), so
 * the two decisions that make AFK reliably sync both ways live here:
 *
 *   - DOWN (SSE `state` event): adopt the server's afk into the local file — but
 *     NEVER while a local toggle is still dirty. That guard is the revert-race fix:
 *     a stale server value pushed on a new session's first SSE flush must not
 *     overwrite a fresh local toggle whose POST /api/device/state was lost.
 *   - UP-clear (heartbeat): clear the dirty flag once the server echoes the SAME
 *     afk we asserted — i.e. the cloud has adopted our toggle (and fired the
 *     afk-off wipe, if any), so the heartbeat no longer needs to re-assert it.
 */
import { isAfkState } from '@imsg/shared';

/** Down-sync: should a server-pushed afk be written to the local file this event? */
export function shouldAdoptDownstreamAfk(args: {
  pushedAfk: string | null | undefined;
  dirty: boolean;
  localAfk: string;
}): boolean {
  return !args.dirty && isAfkState(args.pushedAfk) && args.pushedAfk !== args.localAfk;
}

/** Up-clear: should the heartbeat clear the dirty flag this beat? */
export function shouldClearDirty(args: {
  wasDirty: boolean;
  success: boolean;
  echoAfk: string | null | undefined;
  localAfk: string;
}): boolean {
  return args.wasDirty && args.success && isAfkState(args.echoAfk) && args.echoAfk === args.localAfk;
}
