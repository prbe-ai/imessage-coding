/**
 * LISTEN/NOTIFY bridge for the control plane's SSE streams (device + dashboard)
 * and the legacy decisions long-poll.
 *
 * The schema fires three notifications:
 *   - `decision_ready`  on a decisions INSERT (verdict/answer/grant)  [session]
 *   - `session_message` on a session_messages INSERT (free-text steer) [session]
 *   - `session_state`   on a sessions afk/grant/state change           [session + account]
 * We hold ONE dedicated pg client LISTENing on all three channels and fan each
 * notification out to in-process waiters. Waiters subscribe by KEY — sessionId
 * (the device's per-session stream) or accountId (the dashboard's account-scoped
 * stream). A waiter is a bare wake signal; the caller re-queries Neon (the source
 * of truth) on wake. A timeout returns without a wake (fail-closed: never a
 * default allow).
 *
 * `session_state` wakes BOTH the session waiter (device → push `state`) and the
 * account waiter (dashboard → push `sessions`); the other two channels wake only
 * the session waiter.
 *
 * Per-process: with multiple app instances each LISTENs independently, so every
 * instance is woken; the post-wake DB re-query is the real arbiter.
 */
import { Client } from 'pg';
import { NotifyChannel } from '@imsg/shared';
import { loadEnv } from '../env.ts';

const CHANNELS = [
  NotifyChannel.DECISION_READY,
  NotifyChannel.SESSION_MESSAGE,
  NotifyChannel.SESSION_STATE,
] as const;

/** A bare wake signal for a parked waiter. */
type Waiter = () => void;

/**
 * A registry of waiters keyed by an arbitrary string (sessionId or accountId).
 * Encapsulates the wake/park/cleanup bookkeeping so the session- and
 * account-scoped streams share one well-tested implementation.
 */
function makeWaiterRegistry() {
  /** key -> set of waiters parked on that key. */
  const waiters = new Map<string, Set<Waiter>>();

  function wake(key: string): void {
    const set = waiters.get(key);
    if (!set) return;
    // Copy before iterating: waiters typically unsubscribe on wake.
    for (const w of [...set]) {
      try {
        w();
      } catch (err) {
        console.error('[listener] waiter threw', err);
      }
    }
  }

  /**
   * Wait until a NOTIFY lands for `key`, or until `timeoutMs` elapses. Resolves
   * true if woken by a NOTIFY, false on timeout/abort. The caller does the DB
   * re-query (the arbiter of truth).
   */
  function waitFor(key: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const set = waiters.get(key) ?? new Set<Waiter>();
      waiters.set(key, set);

      const cleanup = (): void => {
        set.delete(waiter);
        if (set.size === 0) waiters.delete(key);
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      const waiter: Waiter = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(true);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      }, timeoutMs);

      set.add(waiter);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  return { wake, waitFor };
}

const sessionWaiters = makeWaiterRegistry();
const accountWaiters = makeWaiterRegistry();

let client: Client | undefined;
let starting: Promise<void> | undefined;

function handleNotification(channel: string, payloadText: string | undefined): void {
  if (!(CHANNELS as readonly string[]).includes(channel) || !payloadText) return;
  let payload: { session_id?: string; account_id?: string };
  try {
    payload = JSON.parse(payloadText) as { session_id?: string; account_id?: string };
  } catch {
    console.error('[listener] unparseable payload on', channel, payloadText);
    return;
  }
  // All channels carry a session_id → wake the device's session stream.
  if (payload.session_id) sessionWaiters.wake(payload.session_id);
  // Only session_state is account-fanned → wake the dashboard's account stream.
  if (channel === NotifyChannel.SESSION_STATE && payload.account_id) {
    accountWaiters.wake(payload.account_id);
  }
}

/**
 * Ensure the dedicated LISTEN client is connected (idempotent, concurrency
 * safe). On connection drop it auto-reconnects with a short backoff so parked
 * waiters still get woken (they also have their own timeout as a floor).
 */
export async function ensureListener(): Promise<void> {
  if (client) return;
  if (starting) return starting;

  starting = (async () => {
    const env = loadEnv();
    const c = new Client({ connectionString: env.databaseUrl });
    c.on('notification', (msg: { channel: string; payload?: string }) => {
      handleNotification(msg.channel, msg.payload);
    });
    c.on('error', (err: Error) => {
      console.error('[listener] client error', err.message);
    });
    c.on('end', () => {
      if (client === c) client = undefined;
      scheduleReconnect();
    });
    await c.connect();
    for (const ch of CHANNELS) await c.query(`LISTEN ${ch}`);
    client = c;
  })();

  try {
    await starting;
  } finally {
    starting = undefined;
  }
}

const RECONNECT_DELAY_MS = 1_000;
function scheduleReconnect(): void {
  setTimeout(() => {
    ensureListener().catch((err) => {
      console.error('[listener] reconnect failed', err);
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

/**
 * Wait until ANY event (decision, steer, or state change) lands for `sessionId`,
 * or until `timeoutMs` elapses (device per-session stream + decisions long-poll).
 */
export function waitForSessionEvent(
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return sessionWaiters.waitFor(sessionId, timeoutMs, signal);
}

/**
 * Wait until a `session_state` change lands for any session on `accountId`, or
 * until `timeoutMs` elapses (the dashboard's account-scoped SSE stream).
 */
export function waitForAccountEvent(
  accountId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return accountWaiters.waitFor(accountId, timeoutMs, signal);
}

/** @deprecated Alias retained for the legacy decisions long-poll. */
export const waitForDecision = waitForSessionEvent;

/** Close the dedicated listener client (graceful shutdown). */
export async function closeListener(): Promise<void> {
  const c = client;
  client = undefined;
  if (c) await c.end();
}
