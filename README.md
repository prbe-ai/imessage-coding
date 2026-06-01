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
   │    (raw-body HMAC verify)       │      │  • Home: sessions, AFK/grant toggle│
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
        📱 phone        │  • imsg CLI (pair · afk · grant · status) │
                        │  • durable outbox + killswitch + sanitize │
                        └──────────────────────────────────────────┘

  Shared contract: packages/shared (@imsg/shared) — enums + types every
  package imports.  Transport port: packages/transport (@imsg/transport).
```

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
  dashboard/       # Next.js 16 — onboarding, sessions, AFK/grant, integrations
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

## Toolchain

- **Bun** workspaces (no npm/pnpm). `bun install` at the root.
- **TypeScript** strict — `tsconfig.base.json` (the dashboard has its own
  Next-flavored tsconfig).
- `@imsg/shared` and `@imsg/transport` ship as **TypeScript source** (no build
  step); consumers import them directly. The dashboard transpiles `@imsg/shared`
  via `next.config.ts` `transpilePackages`.

## Environment

```sh
cp .env.example .env   # then fill in secrets
```

`.env.example` is the full contract — every variable, who reads it, and which
ones are shared. The load-bearing shared secret is **`DEVICE_TOKEN_PEPPER`**: it
MUST be identical in the control-plane and the dashboard (token hashes won't
match otherwise, and pairing silently breaks). You create the **AgentPhone API
key + agent**, the **Google OAuth client**, and a Neon database.

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
bun run bin/imsg.ts grant edits   # auto-allow file edits this session
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

**2. Control plane — Fly**

- `apps/control-plane/Dockerfile` + `fly.toml` are included.

  ```sh
  cd apps/control-plane
  fly launch --no-deploy     # first time (or `fly apps create`)
  fly secrets set DATABASE_URL=... AGENTPHONE_API_KEY=... AGENTPHONE_AGENT_ID=... \
                  AGENTPHONE_WEBHOOK_SECRET=... LLM_API_KEY=... \
                  DEVICE_TOKEN_PEPPER=... WEBHOOK_BASE_URL=https://msg.example.com
  fly deploy
  ```

- Point the AgentPhone webhook at `https://<host>/api/agentphone/webhook`.
- `GET /healthz` (liveness) and `GET /readyz` (DB reachability) are available
  for Fly health checks.

**3. Dashboard — Vercel**

- Import `apps/dashboard` as the project root (Next.js, auto-detected).
- Set env vars in Vercel: `DATABASE_URL`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
  `CONTROL_PLANE_URL`, `DEVICE_TOKEN_PEPPER` (same value as the control plane),
  `WEBHOOK_BASE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_AGENT_PHONE_NUMBER`.
- The Google OAuth redirect URI is `${BETTER_AUTH_URL}/api/idp/callback/google`.
- `next.config.ts` also emits a `standalone` build, so the dashboard can
  alternatively run as a Docker image if you don't use Vercel.

## Safety model (why this is safe to leave AFK)

- **Destructive approvals are deterministic-only.** The LLM classifies intent
  but can never `allow` a destructive tool (anything that isn't a file edit).
  A destructive allow requires a deterministic binding — a tapback/inline reply
  to the exact prompt, or exactly one pending request. Otherwise the orchestrator
  asks which. See `apps/control-plane/src/orchestrator/safety.ts`.
- **Fail-closed everywhere it matters.** Long-poll timeouts return empty (never a
  default allow); the webhook hard-fails if the HMAC secret is unset; the device
  only ever relays a verdict it explicitly received.
- **Egress killswitch is fail-OPEN and separate from the approval path** — it can
  pause sending but can never turn a deny into an allow.
- **Secrets are sanitized before egress** and tokens are stored only as peppered
  hashes.
