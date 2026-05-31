/**
 * @imsg/device — egress killswitch (fail-OPEN).
 *
 * Two layers, both governing ONLY egress (attention posting + heartbeat) — NOT
 * the approval path, which is fail-CLOSED and lives in the hook/channel:
 *
 *   1. Local sentinel: presence of ${deviceDir}/.disabled hard-disables egress.
 *      This is the user's "stop sending" switch (set/cleared by the CLI or by
 *      hand) and is checked synchronously, no network.
 *
 *   2. Remote poll: GET /api/device/state carries an `enabled` flag the control
 *      plane can flip. Cached for KILLSWITCH_TTL_MS. On fetch failure it FAILS
 *      OPEN (keeps operating) — losing reachability already stops egress, so
 *      failing closed would just amplify a transient hiccup. Mirrors the
 *      prbe-cc-tap-plugin killswitch exactly: graceful pause, not fail-secure.
 *
 * CRITICAL invariant: this module must NEVER influence permission verdicts.
 * A killswitch that fails open must not, by any path, turn a "deny" into an
 * "allow". Egress and approval are deliberately separate code paths.
 */
import { existsSync } from 'node:fs';
import { DeviceApiRoute } from '@imsg/shared';
import { KILLSWITCH_TTL_MS, deviceApiUrl, disabledFile } from './config.ts';
import { Classification, getJson, parseJson } from './httpclient.ts';

interface Cached {
  enabled: boolean;
  fetchedAt: number;
  fetchSucceeded: boolean;
}

let cache: Cached | null = null;
const STALE_FALLBACK_LIMIT_MS = 30 * 60 * 1_000;

/** Local hard-disable sentinel — synchronous, no network. */
export function localDisabled(): boolean {
  return existsSync(disabledFile());
}

/**
 * Returns whether egress is currently enabled. Cheap to call (cached).
 * Local sentinel short-circuits to disabled. Remote failures fail OPEN.
 */
export async function egressEnabled(token: string): Promise<boolean> {
  if (localDisabled()) return false;

  const now = Date.now();
  if (cache && cache.fetchSucceeded && now - cache.fetchedAt < KILLSWITCH_TTL_MS) {
    return cache.enabled;
  }

  const resp = await getJson(deviceApiUrl(DeviceApiRoute.STATE), { bearer: token, timeoutMs: 10_000 });
  if (resp.classification === Classification.SUCCESS) {
    const body = parseJson<{ enabled?: boolean }>(resp);
    const enabled = body?.enabled !== false; // default-on unless explicitly false
    cache = { enabled, fetchedAt: now, fetchSucceeded: true };
    return enabled;
  }

  // Non-success: prefer a fresh-enough last-known value, else fail OPEN.
  if (cache && now - cache.fetchedAt < STALE_FALLBACK_LIMIT_MS) return cache.enabled;
  cache = { enabled: true, fetchedAt: now, fetchSucceeded: false };
  return true;
}

/** Test/CLI helper: drop the cache so the next call re-polls. */
export function resetCache(): void {
  cache = null;
}
