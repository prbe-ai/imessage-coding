/**
 * @imsg/device — session-state ping (direct POST, no outbox).
 *
 * State pings (TURN_START → active, TURN_COMPLETE → idle, BLOCKED → waiting) are
 * low-volume, latency-sensitive status signals. Unlike the high-volume activity
 * transcript — which batches through a durable outbox — they DIRECT-POST to the
 * control plane and are not queued: a dropped ping self-heals on the next
 * transition. They carry no transcript content, so (like cwd / the session
 * title) they are NOT AFK-gated — the dashboard shows live status at the keyboard.
 *
 * Shared by the lifecycle hook (state-hook.ts) and the PreToolUse intercept
 * (intercept.ts, which emits BLOCKED when a native question/plan opens AFK-off).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type AttentionEvent, type AttentionKind, DeviceApiRoute } from '@imsg/shared';
import { deviceApiUrl, deviceIdFile } from '../src/config.ts';
import { loadToken } from '../src/creds.ts';
import { postJson } from '../src/httpclient.ts';

/** Cap the per-hook block: a state ping must never stall the session on a bad
 *  network. Typical control-plane RTT is well under this; on a slow/offline
 *  network the ping is abandoned at the cap and the state self-heals on the next
 *  transition. Kept tight because some pings sit in-band (the PreToolUse BLOCKED
 *  ping fronts a native question/plan prompt). */
const STATE_PING_TIMEOUT_MS = 1_500;

function readDeviceId(): string {
  try {
    return readFileSync(deviceIdFile(), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Best-effort direct POST of one session-state ping. Never throws. No-op when
 * unpaired (no token) or the session id is unknown. The server maps the kind to
 * sessions.state and (for state-only kinds) does NOT create an attention row.
 */
export async function postState(kind: AttentionKind, sessionId: string): Promise<void> {
  const token = loadToken();
  if (!token || !sessionId) return;
  const event: AttentionEvent = {
    id: randomUUID(),
    deviceId: readDeviceId(),
    sessionId,
    kind,
    createdAt: new Date().toISOString(),
  };
  try {
    await postJson(deviceApiUrl(DeviceApiRoute.ATTENTION), JSON.stringify({ events: [event] }), {
      bearer: token,
      timeoutMs: STATE_PING_TIMEOUT_MS,
    });
  } catch {
    /* best-effort: a dropped state ping self-heals on the next transition */
  }
}
