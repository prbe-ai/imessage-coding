/**
 * LISTEN/NOTIFY bridge for the device-decisions long-poll.
 *
 * The schema's `trg_decision_ready` trigger fires `pg_notify('decision_ready',
 * json{decision_id,attention_id,session_id,account_id})` on every decisions
 * INSERT. We hold ONE dedicated pg client running `LISTEN decision_ready` and
 * fan each notification out to in-process waiters subscribed by session id.
 *
 * Long-poll semantics (fail-closed): a waiter that wakes re-queries Neon for
 * the session's resolved decisions; it never trusts the notification payload as
 * the source of truth, and a timeout returns EMPTY (never a default allow).
 *
 * Important: this is per-process. With multiple app instances each instance
 * LISTENs independently, so every instance is woken — correct for horizontal
 * scale. A waiter parked on instance A is woken because A also receives the
 * NOTIFY; the post-wake DB re-query is the real arbiter.
 */
import { Client } from 'pg';
import { loadEnv } from '../env.ts';

/** Parsed `decision_ready` notification payload. */
export interface DecisionReady {
  decision_id: string;
  attention_id: string;
  session_id: string;
  account_id: string;
}

const CHANNEL = 'decision_ready';

type Waiter = (payload: DecisionReady) => void;

/** sessionId -> set of waiters parked on that session. */
const waiters = new Map<string, Set<Waiter>>();

let client: Client | undefined;
let starting: Promise<void> | undefined;

function handleNotification(channel: string, payloadText: string | undefined): void {
  if (channel !== CHANNEL || !payloadText) return;
  let payload: DecisionReady;
  try {
    payload = JSON.parse(payloadText) as DecisionReady;
  } catch {
    console.error('[listener] unparseable decision_ready payload', payloadText);
    return;
  }
  const set = waiters.get(payload.session_id);
  if (!set) return;
  // Copy before iterating: waiters typically unsubscribe on wake.
  for (const w of [...set]) {
    try {
      w(payload);
    } catch (err) {
      console.error('[listener] waiter threw', err);
    }
  }
}

/**
 * Ensure the dedicated LISTEN client is connected. Idempotent and concurrency
 * safe. On connection drop, it auto-reconnects with a short backoff so parked
 * long-polls still get woken (they also have their own timeout as a floor).
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
      // Connection closed — drop our ref and reconnect lazily.
      if (client === c) client = undefined;
      scheduleReconnect();
    });
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
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
 * Wait until a decision lands for `sessionId`, or until `timeoutMs` elapses.
 * Resolves true if woken by a NOTIFY, false on timeout. The caller is
 * responsible for the actual DB re-query (the arbiter of truth).
 */
export function waitForDecision(
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

/** Close the dedicated listener client (graceful shutdown). */
export async function closeListener(): Promise<void> {
  const c = client;
  client = undefined;
  if (c) await c.end();
}
