# Per-account agent-number assignment (Phase 1: single shared number)

Branch: feat/agent-number-pool · Plan reviewed via /plan-eng-review 2026-06-01

## Decisions
- Pool table `agent_numbers` + `accounts.agent_number_id` FK.
- EAGER assign in `ensureAccount()`, BEST-EFFORT (NULL on empty pool, never throws).
- FAIL-LOUD scoped to `/api/onboarding/start` only (500 `no_agent_number_provisioned`).
- Seed from the live AgentPhone API (no hardcoded number in repo).
- Inbound routing UNCHANGED (still `from`-based).

## Tasks
- [x] T1 schema: `agent_numbers` + `accounts.agent_number_id` (db/schema.sql)
- [x] T2 `lib/agent-number.ts` `ensureAgentNumberForAccount` (idempotent, concurrency-safe)
- [x] T3 `ensureAccount()` eager best-effort assign
- [x] T4 `/api/onboarding/start` returns `agentNumber`; 500 on null + contract type
- [x] T5 `GET /api/account/agent-number` + client fn + Home CTA self-chat fix
- [x] T6 onboarding page: deep link from `start.agentNumber`; drop NEXT_PUBLIC env
- [x] T7 `apps/dashboard/scripts/seed-agent-numbers.ts` (AgentPhone API -> upsert)
- [x] T8 remove `NEXT_PUBLIC_AGENT_PHONE_NUMBER` from `.env.dashboard.example`
- [x] Verify: bun install + dashboard typecheck EXIT=0; live DDL+seed via Neon MCP

## Review
- DDL applied to neondb (flat-haze-76011530): `agent_numbers` table + `accounts.agent_number_id` FK. Additive, non-destructive.
- Seeded from the live AgentPhone API (active/imessage number + agent_id pulled at runtime, never hardcoded). Idempotent upsert, single row.
- Verified: col + FK exist; assigner pick returns the number; account_count=0 (no backfill).
- Dashboard `tsc --noEmit` EXIT=0. Seed script runs under bun (fails loud on missing env).
- NOT done (left for you): commit/push/merge; full onboarding e2e smoke with the app running.
- Inbound routing UNCHANGED (still from-based). Fail-loud scoped to onboarding/start only.
