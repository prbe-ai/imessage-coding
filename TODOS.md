# TODOS — imessage-coding V1

Deferred items from the `/review` of `build/v1` (2026-05-31). The 7 P1 findings were
fixed in-branch; these P2/P3 items are tracked follow-ups. None block the build
(typecheck/lint/build clean). Several P2s affect whether features fully work end-to-end
once deployed — fix before GA.

## P2 — functional gaps (fix before GA)

- [ ] **Heartbeat drops afk/grant.** `apps/control-plane/src/routes/device.ts` HEARTBEAT reads only `sessionId`+`cwd`; the device heartbeats afk/grant but they never reach the DB, so the dashboard shows stale state. Fix: parse optional afk/grant (validate via `isAfkState`/`isGrantLevel`) → `updateSessionState`.
- [ ] **Long-poll lost-wakeup race (~25s added latency).** `routes/device.ts` runs `listDecisionsForSession()` before registering the waiter; a NOTIFY in that window is dropped and the poll sleeps the full timeout. Fix: subscribe-then-check — register waiter (`ensureListener`+`waitForDecision`) BEFORE the initial read; cancel if the read already has rows.
- [ ] **`since` cursor ms truncation.** `db/repo.ts listDecisionsForSession` returns the cursor at ms precision while filtering at µs → can skip/double-deliver same-ms decisions. Fix: full-precision opaque cursor, or `(resolved_at, id)` keyset with `ORDER BY resolved_at, id`.
- [ ] **STEER is a silent no-op that echoes back to the user.** `orchestrator/index.ts` STEER calls `sendOutbound(...text)` → texts the steer back to the sender; nothing reaches the session. Fix: implement a real session-inbound relay (persist a steer decision the device long-poll injects), or have STEER reply honestly that live steering isn't wired yet.
- [ ] **SMS deep-link missing `?` separator.** `apps/dashboard/src/lib/deep-link.ts` builds `sms:${recipient}&body=...` so iOS parses the number+body as the recipient and drops the onboarding token whenever the agent number is set. Fix: `sms:${recipient}?&body=...` or `sms:/open?addresses=...&body=...`; verify on a real device.
- [x] **install-base / control-plane URL mismatch + piped install can't fetch the plugin.** `pairing-token/route.ts` built the one-liner from `NEXT_PUBLIC_APP_URL` but passed neither `IMSG_CONTROL_PLANE_URL` (→ device fell back to `localhost:8080` → `invalid_pairing_token`) nor any way to obtain the plugin source — so `curl | sh` died at "set IMSG_DEVICE_SRC". FIXED: the build now ships `public/imsg-device.tar.gz`; `install.sh` downloads+unpacks it from `IMSG_INSTALL_BASE` when piped; the minted one-liner injects both `IMSG_INSTALL_BASE` and `IMSG_CONTROL_PLANE_URL`.
- [ ] **Hardcoded `direction` strings.** `logMessage`/`recentMessages` + call sites use literal `'inbound'|'outbound'` instead of the `MessageDirection` enum from `@imsg/shared` (global no-hardcoded-enum rule). Fix: type as `MessageDirection`, replace literals.
- [ ] **Onboarding `confirm` route is over-broad / redundant.** `consumeOnboardingTokenAndLinkNumber` already stamps `verified_at` at link time, so `/api/onboarding/confirm` gates nothing and UPDATEs `verified_at` on ALL the account's conversations (unscoped). Fix: pick one verification authority — drop confirm (token+signed-webhook is sufficient) OR leave `verified_at` NULL at link and set it only in confirm, scoped to the matched phone_number, asserting exactly one row.

## P3 — hardening / cleanup

- [ ] **SMS lower-trust + E.164 normalization.** Singleton destructive-allow + exact un-normalized `findAccountByPhone` makes spoof-number+"yes" the highest-impact chain over SMS. Fix: require explicit deterministic binding for destructive singleton allows; treat `MessageChannel.SMS` as lower-trust; normalize to E.164 before lookup.
- [ ] **Onboarding `attempts` rate-limit is dead** (incremented only after a successful match, never checked). 192-bit tokens make brute force infeasible, but the advertised control doesn't exist. Fix: remove the column+constant and document entropy+TTL as the defense, OR implement real per-source failed-attempt accounting. Add coarse rate-limiting in front of the webhook + `/api/device/pair`.
- [ ] **Cross-account phone re-bind.** `ON CONFLICT (phone_number) DO UPDATE SET account_id` silently re-points a number verified to account A → account B (with a valid B token, no A consent). Fix: refuse/require re-verify when the existing row is verified to a different account; log/alert.
- [ ] **`constantTimeEqualHex` dead export** in `auth/device.ts` (zero callers). Remove or use at the token-hash compare.
- [ ] **Dockerfile non-frozen fallback.** `bun install --frozen-lockfile || bun install` silently changes the dep graph on a stale lockfile. Fix: drop the `|| bun install` so a stale lockfile fails loudly; keep `bun.lock` current.
- [ ] **api_base SSRF/credential-leak guard.** `llm.ts` + `transport/agentphone.ts` build fetch URLs from operator env with no https/host check and attach the Bearer unconditionally. Fix: validate `*_API_BASE` is https (optionally allowlisted) at boot, fail closed.
- [ ] **Pairing token in argv/env.** `install.sh` passes the token via `TOKEN=… sh` + `imsg pair "$TOKEN"` (visible in history/process table). Single-use + 30min TTL bounds it. Fix: read from stdin / 0600 temp file on shared hosts.
