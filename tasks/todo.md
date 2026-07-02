# AgentPhone → Sendblue migration

Big-bang cutover. Global `MESSAGING_PROVIDER` switch (no per-account routing).
Signup becomes invite-gated (email richard@prbe.ai on each request; manual DB
approval). Tapbacks + reply-threading dropped (typed yes/no approvals).

## Build (no keys needed — all unit-testable / typecheckable now)

### Provider switch (control plane)
- [x] `@imsg/shared` enums: add `MessagingProvider` + `AccessStatus`
- [x] `SendblueTransport` adapter + tests — DONE (22/22 green)
- [x] `env.ts`: `MESSAGING_PROVIDER` + `sendblue` config block
- [x] `transport.ts`: `getTransport()` branches on provider
- [x] `routes/webhook-sendblue.ts`: `POST /api/sendblue/webhook/:token` (URL-secret verify, dedup on `message_handle`)
- [x] `app.ts`: mount the Sendblue route

### Signup gating + email-on-signup (dashboard)
- [x] `db/schema.sql`: `accounts.access_status` (default `pending`) + `requested_phone` + `requested_at`; backfill existing onboarded accounts → `approved`
- [x] `server-session.ts`: thread `access_status` through `ensureAccount` + `AccountContext`
- [x] `contracts.ts`: `accessStatus` + `accessRequested` on status; `RequestAccessRequest`
- [x] `api/onboarding/status`: return `accessStatus` + `accessRequested`
- [x] `api/onboarding/request-access`: record phone + email richard@prbe.ai (Resend)
- [x] `lib/email.ts`: Resend send helper (skips gracefully if unconfigured)
- [x] `onboarding/page.tsx`: `pending` → phone-input `gate` → centered `requested` page; `approved` → existing flow unchanged

### Config / docs
- [x] `.env.control.example`: `MESSAGING_PROVIDER`, `SENDBLUE_*`
- [x] `.env.dashboard.example`: `RESEND_API_KEY`, `RESEND_FROM`, `SIGNUP_NOTIFY_EMAIL`
- [x] typecheck control-plane + dashboard + transport; run transport tests

## Keys / accounts needed from Richard (critical path)
- Sendblue (free Sandbox): `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`; add own number as contact for testing
- `SENDBLUE_WEBHOOK_SECRET`: generated below, paste into Sendblue webhook config
- Resend: `RESEND_API_KEY`, verify prbe.ai (or use onboarding@resend.dev for test)

## Pre-cutover test plan — ALL PASSED 2026-07-02 (staging Fly + Neon branch)
1. Adapter unit tests — ✅ 67/67
2. Live outbound send → real iMessage to Richard — ✅
3. Inbound webhook: real Sendblue text → staging → orchestrate → reply — ✅ (Richard got the reply)
4. Full loop — ✅ conversational proven; AFK approval path validated-by-construction (same inbound path, unchanged orchestrator/safety)
5. Signup email (Resend) — ✅ accepted/delivered. (Signup UI gating: logic typechecks; browser test optional via Vercel preview.)

Infra used: Neon branch `br-raspy-meadow-akoaq570`; Fly app `imsg-control-plane-staging`.
CLEANUP OWED: Sendblue `receive` webhook → staging URL (repoint at cutover); tear down staging app + branch when done. Prod untouched.

## Cutover runbook
1. Repoint Sendblue "receive" webhook → prod `/api/sendblue/webhook/<secret>`
2. Apply schema (access_status etc.) to prod DB
3. Set prod Fly secrets: `MESSAGING_PROVIDER=sendblue`, `SENDBLUE_*`, `RESEND_*`; deploy
4. Add the ≤10 kept users' numbers to Sendblue (`sendblue add-contact`)
5. Send migration text to all users via AgentPhone (copy below)
6. Once kept users have texted the new number & verified → cancel AgentPhone

## Migration text (send via AgentPhone before cutover)
> Heads up — imessage-coding is moving to a new number. To keep steering your
> coding agents from iMessage, text this new number once to reconnect: <NEW_NUMBER>.
> (Same setup, nothing to reinstall.) Space is limited on the new plan, so reply
> here if you'd like to be kept on. — Richard

## Review (2026-07-01)

All build items done. Verified: transport tests 67/67 green; typecheck clean on
`@imsg/transport`, `apps/control-plane`, `apps/dashboard`. (`packages/shared`
standalone `tsc` fails ONLY on a pre-existing `types:["bun"]` + missing
`bun-types` install — unrelated to this change; the enums typecheck fine wherever
consumed.)

Files touched:
- shared: `enums.ts` (+MessagingProvider, +AccessStatus)
- control-plane: `env.ts`, `transport.ts`, `routes/webhook-sendblue.ts` (new), `app.ts`
- transport: `sendblue.ts` (new, prior), `sendblue.test.ts` (new, prior), `index.ts`
- db: `schema.sql` (accounts.access_status/requested_phone/requested_at + backfill)
- dashboard: `server-session.ts`, `api/onboarding/status`, `api/onboarding/confirm`,
  `api/onboarding/request-access` (new), `lib/email.ts` (new), `lib/api/contracts.ts`,
  `lib/api/onboarding.ts`, `app/onboarding/page.tsx`
- config: `.env.control.example`, `.env.dashboard.example`

NOT done (needs Richard's keys / live infra): apply schema to a Neon branch,
stand up staging control plane, run live send / webhook / AFK-loop / signup-email
tests, then prod cutover. All code is dormant behind `MESSAGING_PROVIDER=agentphone`
(default) — no live-user impact until the provider is flipped.
