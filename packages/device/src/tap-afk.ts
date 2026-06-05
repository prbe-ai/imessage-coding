/**
 * @imsg/device — pure per-tick decision for the tap's EPHEMERAL, AFK-gated DB
 * mirror. Extracted from bin/tap.ts (which can't be imported — it runs main() on
 * import) so the edge behavior is unit-testable.
 *
 * The DB copy of session activity exists ONLY while the user is AFK:
 *   - shipping requires egress (killswitch) AND afk on;
 *   - the off→on edge backfills the whole session from byte 0 (so the orchestrator
 *     sees context from before the user stepped away);
 *   - the on→off edge discards the un-shipped outbox (the server wipes the DB on
 *     that transition, so a later drain must not re-populate it).
 */
export interface AfkTick {
  /** Upload activity this tick? (egress enabled AND afk on) */
  shipping: boolean;
  /** off→on edge while shipping → re-seed from byte 0 (full backfill). */
  shouldBackfill: boolean;
  /** on→off edge → discard the un-shipped activity outbox. */
  shouldClearOutbox: boolean;
}

/** Pure: given the previous afk state and this tick's afk + egress, decide. */
export function classifyAfkTick(prevAfk: boolean, afkOn: boolean, enabled: boolean): AfkTick {
  const shipping = enabled && afkOn;
  return {
    shipping,
    shouldBackfill: shipping && !prevAfk,
    shouldClearOutbox: !afkOn && prevAfk,
  };
}
