/**
 * LISTEN/NOTIFY bridge for the control plane's SSE streams (device + dashboard)
 * and the legacy decisions long-poll.
 *
 * The schema fires three notifications:
 *   - `decision_ready`  on a decisions INSERT (verdict/answer)        [session]
 *   - `session_message` on a session_messages INSERT (free-text steer) [session]
 *   - `session_state`   on a sessions state change                     [session + account]
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
  NotifyChannel.DEVICE_STATE,
  NotifyChannel.DECISION_DELIVERED,
  NotifyChannel.MESSAGE_DELIVERED,
] as const;

/** The two confirmation channels carry only a row `id` and wake the
 *  delivery-confirmation waiter (not session/account/device waiters). */
const DELIVERED_CHANNELS: readonly string[] = [
  NotifyChannel.DECISION_DELIVERED,
  NotifyChannel.MESSAGE_DELIVERED,
];

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
/** Keyed by ROW id (attention_id / message id) — woken by the *_delivered
 *  channels when the device confirms it injected that decision/steer. */
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
  // Confirmation channels are keyed by the row id → wake the delivery waiter.
  if (DELIVERED_CHANNELS.includes(channel)) {
    if (payload.id) deliveredWaiters.wake(payload.id);
    return;
  }
  // decision_ready / session_message / session_state carry a session_id → wake
  // the device's per-session stream.
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
 *  connect must not stall the caller; the post-wake re-query is the safety net). */
const ENSURE_LISTENER_BUDGET_MS = 2_000;

/**
 * Resolve `p`, but never later than `ms` (then `fallback`). A rejection also
 * resolves to `fallback`. Used to bound every DB touch in waitForDelivered so a
 * hung query (pool exhaustion, partition) can NEVER hang the detached watcher —
 * the function always settles. Resolving twice is a no-op (a Promise settles once).
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
 * Wait until the device confirms delivery of the row `key` (an attention_id for
 * a decision, or a message id for a steer), or until `timeoutMs` elapses.
 * Resolves true if confirmed, false on timeout/abort. `isDone` is the caller's
 * per-kind lookup (decisions.delivered_at / session_messages.acked_at).
 *
 * Robustness (every line here defends a way the detached watcher could lie or
 * hang — it must always settle, and must never claim "unconfirmed" when the row
 * is actually delivered):
 *  - ENSURE THE LISTENER: a `*_delivered` NOTIFY only arrives if the dedicated
 *    LISTEN client is up. Boot warm-up is best-effort and never retries an
 *    initial failure, so ensure it HERE (idempotent) — else every confirmation
 *    falsely times out. Bounded so a hung connect can't stall us.
 *  - PARK-BEFORE-QUERY (TOCTOU): register the waiter BEFORE the first re-check,
 *    so a NOTIFY firing in the check→park window isn't stranded (the same hazard
 *    the device SSE loop documents).
 *  - BOUNDED CHECKS: each `isDone` runs under `settleWithin`, so a stuck query
 *    can't outlive the deadline and hang the watcher's `Promise.all`.
 *  - RE-QUERY IS THE ARBITER: after the wake/timeout, query once more — a missed
 *    or reconnect-dropped NOTIFY must not produce a false "unconfirmed" when
 *    `delivered_at`/`acked_at` is in fact set. The DB, not the NOTIFY, decides.
 */
export async function waitForDelivered(
  key: string,
  timeoutMs: number,
  isDone: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  // The NOTIFY can't reach us without the LISTEN client. Bounded + best-effort:
  // a failure falls through to the re-query path, never throws.
  await settleWithin(ensureListener(), ENSURE_LISTENER_BUDGET_MS, undefined);
  if (signal?.aborted) return false;

  // A child controller lets us cancel the parked waiter when a check short-circuits.
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });
  // Register the waiter BEFORE the first re-check (park-before-query invariant).
  const parked = deliveredWaiters.waitFor(key, timeoutMs, controller.signal);
  // A delivery check that can never outlive the deadline (false on hang/throw).
  const check = (): Promise<boolean> => settleWithin(isDone(), timeoutMs, false);
  try {
    // Pre-check: already delivered → done (covers the fast ACK / warm row).
    if (await check()) {
      controller.abort(); // unregister the (now-moot) waiter
      return true;
    }
    // Wait for the NOTIFY wake or the timeout, then RE-QUERY as the arbiter
    // (handles a missed/reconnect-dropped NOTIFY and the wake→here window).
    await parked;
    return await check();
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', onParentAbort);
  }
}

/** @deprecated Alias retained for the legacy decisions long-poll. */
export const waitForDecision = waitForSessionEvent;

/** Close the dedicated listener client (graceful shutdown). */
export async function closeListener(): Promise<void> {
  const c = client;
  client = undefined;
  if (c) await c.end();
}
