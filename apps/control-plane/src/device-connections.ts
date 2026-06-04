/**
 * In-memory registry of sessions that currently hold a LIVE SSE stream to this
 * control plane (the device's `subscribeEvents` connection in channel.ts). The
 * SSE route marks a session connected for the lifetime of its stream; the
 * delivery watcher reads it to decide how long to wait for an ACK before warning:
 * a session with no live stream is genuinely unreachable (warn sooner), while a
 * connected one is probably just slow / mid-reconnect (wait out the debounce).
 *
 * Deliberately in-process — same scope as the orchestrator's per-account locks
 * and the NOTIFY listener ("correct for a single instance"). It is a best-effort
 * HINT, never a correctness gate: the durable delivered_at ACK is still the
 * source of truth, so a missed/duplicated mark only changes warning TIMING, never
 * whether a message is delivered. A multi-instance deployment would replace this
 * with a shared signal (e.g. a presence row), same as the locks.
 *
 * Refcounted by sessionId: a reconnect can briefly overlap the old stream
 * (connect before the old aborts), so we only consider a session disconnected
 * once its LAST stream closes.
 */
const liveStreams = new Map<string, number>();

/** Mark that a session opened an SSE stream. Pair every call with exactly one
 *  markSessionDisconnected (use try/finally around the stream body). */
export function markSessionConnected(sessionId: string): void {
  liveStreams.set(sessionId, (liveStreams.get(sessionId) ?? 0) + 1);
}

/** Mark one of a session's SSE streams closed; the session is "disconnected"
 *  only once the count hits zero (so an overlapping reconnect stays connected). */
export function markSessionDisconnected(sessionId: string): void {
  const next = (liveStreams.get(sessionId) ?? 0) - 1;
  if (next > 0) liveStreams.set(sessionId, next);
  else liveStreams.delete(sessionId);
}

/** True if the session currently holds at least one live SSE stream. */
export function isSessionConnected(sessionId: string): boolean {
  return (liveStreams.get(sessionId) ?? 0) > 0;
}
