# imessage-coding

Drive and steer Claude Code coding sessions from your phone over iMessage.

When you walk away from your keyboard (AFK), permission prompts, questions, and
plans are relayed to your phone as iMessages. You reply in natural language; the
cloud control plane resolves your intent into a decision and feeds it back into
the waiting Claude Code session. Destructive approvals are
**deterministic-only** and **fail-closed** — never inferred by the LLM.

## Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │                  Neon Postgres                 │
                 │  accounts · devices · pairing/onboarding_tokens│
                 │  conversations · sessions · attention_events   │
                 │  decisions (LISTEN/NOTIFY) · message_log        │
                 └──────────────────────────────────────────────┘
                        ▲                              ▲
            pg Pool /   │                              │  pg Pool
         LISTEN/NOTIFY  │                              │  (Better Auth + product)
                        │                              │
   ┌────────────────────┴───────────┐      ┌───────────┴───────────────────────┐
   │   apps/control-plane (Fly)      │      │   apps/dashboard (Vercel)          │
   │   Hono on Bun — stateless       │      │   Next.js 16 — Better Auth (Google)│
   │  • POST /api/agentphone/webhook │      │  • Google SSO + onboarding wizard  │
   │    (raw-body HMAC verify)       │      │  • Home: sessions, AFK toggle      │
   │  • orchestrator (LLM intent +   │      │  • Integrations: mint pairing token│
   │    deterministic safety gate)   │      │  • same-origin /api/* BFF          │
   │  • device API (Bearer token):   │      └────────────────────────────────────┘
   │    pair·attention·decisions     │
   │    ·heartbeat·state             │
   └───────▲─────────────────┬───────┘
           │ AgentPhone       │ device API (Bearer device_token,
           │ send/webhook     │ long-poll decisions)
           │                  ▼
  ┌────────┴───────┐   ┌──────────────────────────────────────────┐
  │   AgentPhone    │   │   packages/device (@imsg/device)          │
  │ iMessage / SMS  │   │   Claude Code plugin on the dev's machine │
  │   provider      │   │  • channel MCP server (permission relay + │
  └────────┬───────┘   │    `reply` chat bridge)                   │
           │            │  • PreToolUse/PermissionRequest hooks     │
        📱 phone        │  • imsg CLI (pair · afk · status)         │
                        │  • durable outbox + killswitch + sanitize │
                        └──────────────────────────────────────────┘

  Shared contract: packages/shared (@imsg/shared) — enums + types every
  package imports.  Transport port: packages/transport (@imsg/transport).
```

The orchestrator's LLM calls (intent classification, the assistant turn) go through
a private **LiteLLM proxy** (`apps/litellm`, deployed as its own Fly app and reached
over flycast at `http://imsg-litellm.flycast/v1`), which fronts Gemini (and
optionally Cerebras). The deterministic safety gate never depends on the LLM.

**The core loop (AFK approval):** Claude Code opens a permission prompt → the
device hook/channel relays it to the control plane as an `attention_event` →
when the session is AFK, the orchestrator texts the user → the user replies →
the orchestrator resolves a `decision` → a Postgres `NOTIFY` wakes the device's
long-poll on `GET /api/device/decisions` → the device relays the verdict back to
Claude Code on the Channels permission notification (matched by `request_id`).

## Monorepo layout (Bun workspaces)

```
apps/
  control-plane/   # Hono on Bun — agentphone webhook, orchestrator, device API
  dashboard/       # Next.js 16 — onboarding, sessions, AFK, integrations
  litellm/         # LiteLLM proxy (deploy-only: upstream image + config.yaml) —
                   #   the assistant's LLM gateway, reached over private Fly flycast
packages/
  shared/          # @imsg/shared — the contract: enums + types every package imports
  transport/       # @imsg/transport — Transport PORT + AgentPhone impl
  device/          # @imsg/device — Claude Code plugin (channel MCP + hooks + CLI)
db/
  schema.sql       # Neon Postgres schema (incl. LISTEN/NOTIFY on decisions)
```

| Package              | Name                  | Role                                              |
| -------------------- | --------------------- | ------------------------------------------------- |
| `packages/shared`    | `@imsg/shared`        | Enums, const-objects, shared types (no deps)      |
| `packages/transport` | `@imsg/transport`     | Swappable messaging transport (AgentPhone impl)   |
| `packages/device`    | `@imsg/device`        | Claude Code device plugin + `imsg` CLI            |
| `apps/control-plane` | `@imsg/control-plane` | Stateless app tier; all state in Neon             |
| `apps/dashboard`     | `@imsg/dashboard`     | Web UI (Better Auth, Google SSO)                  |

`apps/litellm` is **not** a Bun workspace package — it has no `package.json`, just a
`Dockerfile`, `config.yaml`, and `fly.toml`. It packages the upstream LiteLLM proxy
image with our model config and deploys independently (see Deployment).

## Toolchain

- **Bun** workspaces (no npm/pnpm). `bun install` at the root.
- **TypeScript** strict — `tsconfig.base.json` (the dashboard has its own
  Next-flavored tsconfig).
- `@imsg/shared` and `@imsg/transport` ship as **TypeScript source** (no build
  step); consumers import them directly. The dashboard transpiles `@imsg/shared`
  via `next.config.ts` `transpilePackages`.

## Environment

Each app has its own gitignored env file with a tracked `*.example` template:

```sh
cp .env.control.example   .env.control     # apps/control-plane
cp .env.dashboard.example .env.dashboard   # apps/dashboard
cp .env.litellm.example   .env.litellm     # apps/litellm proxy
# then fill in secrets
```

Each `*.example` is the full contract for its app — every variable, who reads it,
and which ones are shared. The load-bearing shared secret is
**`DEVICE_TOKEN_PEPPER`**: it MUST be byte-identical in `.env.control` and
`.env.dashboard` (token hashes won't match otherwise, and pairing silently breaks);
`SSE_TICKET_SECRET` and `DATABASE_URL` are likewise shared between those two. You
create the **AgentPhone API key + agent**, the **Google OAuth client**, a Neon
database, and a **Gemini API key** (for the LiteLLM proxy).

The control-plane and litellm Fly apps each ship a `scripts/sync-fly-secrets.sh`
that pushes their `.env.*` into `fly secrets` for the matching app.

## Local development

```sh
bun install
```

Root scripts run a command across every workspace that defines it:

```sh
bun run typecheck   # tsc --noEmit in all packages (and Next type-check)
bun run lint        # eslint in the dashboard
bun run build       # tsc check in packages; `next build` in the dashboard
bun run dev         # starts the apps that define `dev` (control-plane, dashboard)
```

Run apps individually:

**Control plane** (Hono on Bun, default `:8080`):

```sh
cd apps/control-plane
bun run dev          # bun --watch run src/index.ts
# health: GET http://localhost:8080/healthz  ·  readiness: /readyz
```

**Dashboard** (Next.js 16):

```sh
cd apps/dashboard
bun run dev          # next dev  → http://localhost:3000
# Better Auth schema (run once against your DB):
bun run auth:migrate
```

**Device plugin** (on the machine where you use Claude Code):

```sh
# Easiest: copy the exact one-liner from the dashboard's Integrations page. It
# embeds the pairing token plus IMSG_INSTALL_BASE (dashboard origin, to fetch the
# plugin tarball) and IMSG_CONTROL_PLANE_URL (which control plane to pair against):
curl -fsSL <dashboard-origin>/install.sh \
  | IMSG_INSTALL_BASE=<dashboard-origin> IMSG_CONTROL_PLANE_URL=<control-plane> TOKEN=<pairing-token> sh
# Or, from a checkout (local dev):
cd packages/device
bun run bin/imsg.ts pair <pairing-token>
bun run bin/imsg.ts afk on        # route prompts to your phone
bun run bin/imsg.ts status
```

The plugin's MCP server is started by Claude Code via `.mcp.json`; the
PreToolUse/PermissionRequest hooks are wired via `hooks/hooks.json`. `install.sh`
stages the plugin as a local marketplace, rewrites `bun` to an absolute path,
chains the status line, pre-allows the `reply` tool, and pairs the device.

## Deployment

**1. Database — Neon**

- Create a Neon project; copy its connection string into `DATABASE_URL`.
- Apply the schema:

  ```sh
  psql "$DATABASE_URL" -f db/schema.sql
  ```

  This creates all product tables, the `decisions` LISTEN/NOTIFY trigger, and
  indexes. Better Auth's own `better_auth_*` tables are created separately by
  `bun run auth:migrate` from the dashboard.

**2. LLM proxy — Fly (private)**

Deploy this *before* the control plane — the control plane calls it over flycast.

- `apps/litellm/Dockerfile` + `fly.toml` are included. It's a private app (no
  public IP); the control plane reaches it at `http://imsg-litellm.flycast/v1`.

  ```sh
  cd apps/litellm
  fly apps create imsg-litellm
  ./scripts/sync-fly-secrets.sh --apply   # pushes .env.litellm → fly secrets
  fly deploy --no-public-ips
  fly ips allocate-v6 --private -a imsg-litellm   # private flycast IP only
  ```

- Mint a LiteLLM **virtual key** against `LITELLM_MASTER_KEY` (`POST /key/generate`)
  and put it in `.env.control` as `LLM_API_KEY` (the control plane authenticates to
  the proxy with it). See `apps/litellm/config.yaml` for the model list.

**3. Control plane — Fly**

- `apps/control-plane/Dockerfile` + `fly.toml` are included.

  ```sh
  cd apps/control-plane
  fly launch --no-deploy     # first time (or `fly apps create`)
  ./scripts/sync-fly-secrets.sh --apply   # pushes .env.control → fly secrets
  fly deploy
  ```

  (`LLM_API_BASE` is baked into `fly.toml` as the flycast proxy URL — don't set it
  as a secret.) Point the AgentPhone webhook at `https://<host>/api/agentphone/webhook`.
- `GET /healthz` (liveness) and `GET /readyz` (DB reachability) are available
  for Fly health checks.

**4. Dashboard — Vercel**

- Import `apps/dashboard` as the project root (Next.js, auto-detected).
- Set env vars in Vercel: `DATABASE_URL`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
  `CONTROL_PLANE_URL`, `DEVICE_TOKEN_PEPPER` (same value as the control plane),
  `WEBHOOK_BASE_URL`, `NEXT_PUBLIC_APP_URL`.
- The Google OAuth redirect URI is `${BETTER_AUTH_URL}/api/idp/callback/google`.
- Seed the agent-number pool before onboarding works — `/api/onboarding/start`
  fails closed (`no_agent_number_provisioned`) on an empty pool:

  ```sh
  cd apps/dashboard
  bun run scripts/seed-agent-numbers.ts   # pulls the active number from AgentPhone
  ```

- `next.config.ts` also emits a `standalone` build, so the dashboard can
  alternatively run as a Docker image if you don't use Vercel.

## Safety model

The control plane is the trust boundary, and the device only ever relays a verdict
it was explicitly handed. The approval model is **LLM-decides-with-guardrails**: the
orchestrator's model has the final say on every `allow`/`deny` — there is no
code-enforced gate that prevents it from allowing a destructive tool. The guardrails
constrain *how* it decides and *what the user sees*, not whether it can act:

- **Destructive prompts are described by code, not the LLM.** Anything that isn't a
  file edit (Bash, network, unknown tools) is classified destructive
  (`isDestructiveTool` — fail-closed on unknown tools). For those, the user is
  notified with a **code-generated, truthful** description of the exact tool — never
  LLM-authored prose that could misdescribe what an approval does. See
  `apps/control-plane/src/orchestrator/safety.ts` and `index.ts`.
- **Never guesses a target.** When more than one request is pending for a session,
  the orchestrator refuses to pick and asks which. A tap-back on the exact
  notification (or a lone pending request) binds deterministically and is surfaced
  both to the model (as a hint) and to the user (as a tappable 👍 allow / 👎 deny).
- **Fail-closed everywhere it matters.** Long-poll timeouts return empty (never a
  default allow); the webhook hard-fails if the HMAC secret is unset; a verdict that
  is not exactly `ALLOW` is coerced to deny (it never widens).
- **Egress killswitch is fail-OPEN and separate from the approval path** — it can
  pause sending but can never turn a deny into an allow.
- **Secrets are sanitized before egress** and tokens are stored only as peppered
  hashes.

Because the model has the final say, a destructive approval is ultimately a
judgement over the inbound reply and session context. Treat lower-trust channels
accordingly — SMS sender numbers are spoofable, iMessage identities are not — and
keep the deterministic tap-back binding in the loop for destructive actions.
