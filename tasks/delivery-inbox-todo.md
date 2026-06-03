# Simplify delivery plumbing → one `session_inbox`

Branch: `simplify-delivery-inbox` (worktree, off `8d661c9`).

## Goal
Collapse the two delivery primitives (`decisions`-as-delivery + `session_messages`)
into ONE concept: a row that says "deliver X to this session." `delivered_at` set
ONLY on the device ACK; re-served until then (at-least-once on the wire, deduped to
once into the session). Kill the per-message "no ack after 4s" freak-out.

## Design
One table `session_inbox(id, session_id, account_id, kind, text, request_id, behavior, attention_id, created_at, delivered_at)`.
- `kind='reply'` → `text` injected as a `<channel>` message. Covers question answers, plan approvals/denials, and steers — all "a simple reply".
- `kind='verdict'` → `{request_id, behavior}` relayed on the permission channel to release a native prompt (the one irreducible structured path; can't be plain text).
- `delivered_at` set on device ACK; SSE serves WHERE `delivered_at IS NULL`; re-served until ACK; device dedups by `id`.
- DROP `decisions` (resolution audit folded into `attention_events.resolved`) and `session_messages`.
- DROP the orchestrator delivery watcher + the "✓ Delivered / ⚠️ couldn't confirm" follow-up. Tool result stays "sent (queued)"; `RELAYING IS NOT CONFIRMATION` prompt rule stays.

## Steps
- [ ] shared: `SseEvent` (DECISIONS+SESSION_MESSAGES → INBOX), `NotifyChannel` (one `session_inbox`, drop decision_ready/session_message/*_delivered), types (Decision/SessionMessage → InboxItem), validators.
- [ ] schema.sql: new `session_inbox` + trigger; drop `decisions`/`session_messages` + their triggers.
- [ ] repo.ts: `enqueueReply`/`enqueueVerdict`, `listUndeliveredInbox`, `markInboxDelivered`; rewrite `resolveAttention` to enqueue; delete decisions/steer delivery fns + `is*Delivered`.
- [ ] control-plane device.ts: EVENTS flush → one INBOX event; ACK → one `ids` array; delete legacy DECISIONS long-poll route.
- [ ] listener.ts: one `session_inbox` wake channel; drop `*_delivered` waiters.
- [ ] orchestrator index.ts: `execMessageAgent`/`resolveSessionAction` enqueue inbox rows; delete `watchDeliveries`/`composeDeliveryFollowup`/`DeliveryWatch`/`ctx.deliveries`.
- [ ] device channel.ts: one `applyInbox(kind)` + one `ackInbox(ids)` + one dedup set.
- [ ] tests: update index.test / prompt.test / listener.test to the new contract.
- [ ] Verify: `tsc` all packages + `bun test` green.
- [ ] /review → auto-merge → push → watch Fly deploy.

## Status — DONE (pending review + deploy)
- [x] shared / schema / repo / device route / listener / orchestrator / channel — all migrated to `session_inbox`.
- [x] Kept the confirmation watcher but **30s, warn-only** (silent on success) per user: "send once, expect ack ≤30s, else show the ⚠️". One row → one delivery; device dedups by id so the agent sees it once even if the wire re-serves.
- [x] Latency fixes folded in (from the investigation): SSE heartbeat 25s→15s; device reconnect 5s flat → fast-first (~300ms) capped backoff + jitter.
- [x] tsc clean (5 pkgs) + 98 bun tests green.

## Latency investigation — root causes (ranked)
1. **Orchestrator runs a full LLM turn before the message is enqueued** (biggest controllable latency). NOT fixed here — bypassing the assistant for plain steers is a product decision; surfaced for the user.
2. SSE reconnect 5s flat backoff → fixed (fast-first + cap).
3. SSE heartbeat 25s near Fly idle ceiling → fixed (15s).
4. Per-account serial lock — intentional; mitigated by #1.
5. LiteLLM ~2min cold start (tail risk, min_machines=1 holds it warm); CC acts on injected `<channel>` only at its turn boundary (CC-internal).

## Deploy notes
- schema.sql applied manually via `psql -f` (CI deploys code only). New `session_inbox` is additive; legacy `decisions`/`session_messages` are DROPped (transient queues, safe). Apply timed with the code deploy.
- Device plugin bumped 0.1.6 → 0.1.7; wire protocol changed (INBOX event, `ids` ack) → each machine needs installer re-run + CC restart.


