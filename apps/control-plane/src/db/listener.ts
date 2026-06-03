/**
 * LISTEN/NOTIFY bridge for the control plane's SSE streams (device + dashboard).
 *
 * The schema fires three notifications:
 *   - `session_inbox`  on a session_inbox INSERT (a row to deliver)   [session]
 *   - `session_state`  on a sessions state change                     [session + account]
 *   - `device_state`   on a device afk change (machine-wide toggle)   [device + account]
 * We hold ONE dedicated pg client LISTENing on all three channels and fan each
 * notification out to in-process waiters. Waiters subscribe by KEY — sessionId
 * (the device's per-session stream), accountId (the dashboard's account-scoped
 * stream), or deviceId (the machine-wide afk fan-out). A waiter is a bare wake
 * signal; the caller re-queries Neon (the source of truth) on wake. A timeout
 * returns without a wake (fail-closed: never a default allow).
 *
 * `session_state` wakes BOTH the session waiter (device → push `state`) and the
 * account waiter (dashboard → push `sessions`); `device_state` wakes the device
 * waiter + the account waiter; `session_inbox` wakes only the session waiter.
 *
 * Per-process: with multiple app instances each LISTENs independently, so every
 * instance is woken; the post-wake DB re-query is the real arbiter.
 */
import { Client } from 'pg';
import { NotifyChannel } from '@imsg/shared';
import { loadEnv } from '../env.ts';

const CHANNELS = [
  NotifyChannel.SESSION_INBOX,
  NotifyChannel.SESSION_STATE,
  NotifyChannel.DEVICE_STATE,
  NotifyChannel.INBOX_DELIVERED,
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
const deviceWaiters = makeWaiterRegistry();
/** Keyed by session_inbox ROW id — woken by `inbox_delivered` when the device
 *  confirms it injected that row. Backs the 30s confirmation watcher. */
const deliveredWaiters = makeWaiterRegistry();

let client: Client | undefined;
let starting: Promise<void> | undefined;

function handleNotification(channel: string, payloadText: string | undefined): void {
  if (!(CHANNELS as readonly string[]).includes(channel) || !payloadText) return;
  let payload: { session_id?: string; account_id?: string; device_id?: string; id?: string };
  try {
    payload = JSON.parse(payloadText) as {
      session_id?: string;
      account_id?: string;
      device_id?: string;
      id?: string;
    };
  } catch {
    console.error('[listener] unparseable payload on', channel, payloadText);
    return;
  }
  // inbox_delivered is keyed by the row id → wake the confirmation watcher only.
  if (channel === NotifyChannel.INBOX_DELIVERED) {
    if (payload.id) deliveredWaiters.wake(payload.id);
    return;
  }
  // session_inbox / session_state carry a session_id → wake the device's
  // per-session stream so it re-queries + flushes.
  if (payload.session_id) sessionWaiters.wake(payload.session_id);
  // device_state (machine-wide afk) carries a device_id → wake every live
  // stream for that device so each re-flushes its device-sourced {afk}.
  if (channel === NotifyChannel.DEVICE_STATE && payload.device_id) {
    deviceWaiters.wake(payload.device_id);
  }
  // session_state + device_state are account-fanned → wake the dashboard stream.
  if (
    (channel === NotifyChannel.SESSION_STATE || channel === NotifyChannel.DEVICE_STATE) &&
    payload.account_id
  ) {
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

/**
 * Wait until a `device_state` change (machine-wide afk toggle) lands for
 * `deviceId`, or until `timeoutMs` elapses.
 */
export function waitForDeviceEvent(
  deviceId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return deviceWaiters.waitFor(deviceId, timeoutMs, signal);
}

/**
 * Wait until EITHER a per-session event (decision/steer for `sessionId`) OR a
 * machine-wide `device_state` toggle for `deviceId` lands, or until `timeoutMs`
 * elapses. The device's per-session SSE stream uses this so a dashboard/CLI
 * device toggle reaches every session's hook sub-second.
 *
 * A naive `Promise.race([waitForSession, waitForDevice])` leaks: the LOSING
 * waiter stays parked (Set entry + live timer) until its own timeout, so a busy
 * stream accumulates stale waiters. We instead drive both off ONE inner
 * AbortController and abort it the instant either settles — cancelling the loser
 * immediately (its `waitFor` cleans up on abort).
 */
export function waitForSessionOrDeviceEvent(
  sessionId: string,
  deviceId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const inner = new AbortController();
  const onOuterAbort = (): void => inner.abort();
  if (signal) {
    if (signal.aborted) inner.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const cleanup = (): void => {
    inner.abort(); // cancel whichever waiter hasn't settled yet
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  };
  return Promise.race([
    sessionWaiters.waitFor(sessionId, timeoutMs, inner.signal),
    deviceWaiters.waitFor(deviceId, timeoutMs, inner.signal),
  ]).then((woken) => {
    cleanup();
    return woken;
  });
}

/** Max time to wait on `ensureListener` before proceeding regardless (a hung
 *  connect must not stall the watcher; the post-wake re-query is the safety net). */
const ENSURE_LISTENER_BUDGET_MS = 2_000;

/**
 * Resolve `p`, but never later than `ms` (then `fallback`). A rejection also
 * resolves to `fallback`. Bounds every DB touch in waitForDelivered so a hung
 * query can NEVER hang the detached watcher — it always settles.
 */
function settleWithin<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

/**
 * Wait until the device confirms delivery of the session_inbox row `id` (its
 * delivered_at flips, via the `inbox_delivered` NOTIFY), or until `timeoutMs`
 * elapses. Resolves true if confirmed, false on timeout/abort. `isDone` is the
 * caller's lookup (isInboxDelivered). Backs the orchestrator's 30s warn-only
 * watcher. Defends every way it could lie or hang:
 *  - ENSURE THE LISTENER (bounded) so the NOTIFY can actually reach us.
 *  - PARK-BEFORE-QUERY: register the waiter before the first re-check (TOCTOU).
 *  - BOUNDED CHECKS: each isDone runs under settleWithin.
 *  - RE-QUERY IS THE ARBITER: after wake/timeout, the DB (not the NOTIFY) decides.
 */
export async function waitForDelivered(
  id: string,
  timeoutMs: number,
  isDone: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  await settleWithin(ensureListener(), ENSURE_LISTENER_BUDGET_MS, undefined);
  if (signal?.aborted) return false;

  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });
  // Register the waiter BEFORE the first re-check (park-before-query invariant).
  const parked = deliveredWaiters.waitFor(id, timeoutMs, controller.signal);
  const check = (): Promise<boolean> => settleWithin(isDone(), timeoutMs, false);
  try {
    if (await check()) {
      controller.abort();
      return true;
    }
    await parked;
    return await check();
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', onParentAbort);
  }
}

/** Close the dedicated listener client (graceful shutdown). */
export async function closeListener(): Promise<void> {
  const c = client;
  client = undefined;
  if (c) await c.end();
}
