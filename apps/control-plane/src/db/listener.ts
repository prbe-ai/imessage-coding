/**
 * LISTEN/NOTIFY bridge for the device EVENT STREAM (SSE) and the legacy
 * decisions long-poll.
 *
 * The schema fires two notifications, both carrying a `session_id`:
 *   - `decision_ready`  on every decisions INSERT (verdict/answer/grant)
 *   - `session_message` on every session_messages INSERT (free-text steering)
 * We hold ONE dedicated pg client LISTENing on both channels and fan each
 * notification out to in-process waiters subscribed by session id. A waiter is a
 * bare wake signal — the caller re-queries Neon (the source of truth) on wake;
 * a timeout returns without a wake (fail-closed: never a default allow).
 *
 * Per-process: with multiple app instances each LISTENs independently, so every
 * instance is woken; the post-wake DB re-query is the real arbiter.
 */
import { Client } from 'pg';
import { loadEnv } from '../env.ts';

const CHANNELS = ['decision_ready', 'session_message'] as const;

/** A bare wake signal for a parked session waiter. */
type Waiter = () => void;

/** sessionId -> set of waiters parked on that session. */
const waiters = new Map<string, Set<Waiter>>();

let client: Client | undefined;
let starting: Promise<void> | undefined;

function wake(sessionId: string): void {
  const set = waiters.get(sessionId);
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

function handleNotification(channel: string, payloadText: string | undefined): void {
  if (!(CHANNELS as readonly string[]).includes(channel) || !payloadText) return;
  let sessionId: string | undefined;
  try {
    sessionId = (JSON.parse(payloadText) as { session_id?: string }).session_id;
  } catch {
    console.error('[listener] unparseable payload on', channel, payloadText);
    return;
  }
  if (sessionId) wake(sessionId);
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
 * Wait until ANY event (decision or session message) lands for `sessionId`, or
 * until `timeoutMs` elapses. Resolves true if woken by a NOTIFY, false on
 * timeout/abort. The caller does the DB re-query (the arbiter of truth).
 */
export function waitForSessionEvent(
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const set = waiters.get(sessionId) ?? new Set<Waiter>();
    waiters.set(sessionId, set);

    const cleanup = (): void => {
      set.delete(waiter);
      if (set.size === 0) waiters.delete(sessionId);
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

/** @deprecated Alias retained for the legacy decisions long-poll. */
export const waitForDecision = waitForSessionEvent;

/** Close the dedicated listener client (graceful shutdown). */
export async function closeListener(): Promise<void> {
  const c = client;
  client = undefined;
  if (c) await c.end();
}
