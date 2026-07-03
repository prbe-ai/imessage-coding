# iMessage for Claude Code / Codex

**Drive and steer your AI coding agent from your phone — over iMessage.**

`imessage-coding` is an open-source, self-hostable bridge that lets you control
[Claude Code](https://www.anthropic.com/claude-code) and
[OpenAI Codex](https://openai.com/codex/) coding sessions from your phone. When
you walk away from your keyboard (**AFK**), the permission prompts, questions,
and plans your agent would normally block on are relayed to you as **iMessages**.
You reply in plain English; a cloud control plane turns your intent into a
decision and feeds it back into the waiting session — so your agent keeps making
progress while you're at lunch, on a walk, or away from your desk.

Destructive approvals are **described by code, never by the LLM**, and the
device only ever relays a verdict it was explicitly handed.

<p>
  <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg">
  <img alt="Built with Bun" src="https://img.shields.io/badge/Built%20with-Bun-000000?logo=bun&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-cc785c">
  <img alt="OpenAI Codex" src="https://img.shields.io/badge/OpenAI%20Codex-supported-412991">
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg">
</p>

> **In one line:** remote control and steering for Claude Code & Codex over
> iMessage/SMS — approve permission prompts, answer questions, and redirect
> agentic coding runs from anywhere, without a laptop.

---

## Table of contents

- [Why imessage-coding?](#why-imessage-coding)
- [Features](#features)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Monorepo layout](#monorepo-layout-bun-workspaces)
- [Toolchain](#toolchain)
- [Configuration](#configuration)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Safety model](#safety-model)
- [Contributing](#contributing)
- [License](#license)

---

## Why imessage-coding?

Agentic coding tools are great until they stop and wait for you. A long Claude
Code or Codex run pauses on every permission prompt (run this command? edit this
file? exit plan mode?), every clarifying question, and every plan that needs a
go-ahead. If you step away, the run stalls until you're back at the keyboard.

`imessage-coding` closes that gap. It turns each of those blocking moments into a
text message you can answer from your phone:

- **Stay in flow while you're away.** Approve, deny, answer, or steer by text —
  no SSH, no laptop, no VNC.
- **Works with the agents you already use.** Installs as a plugin into Claude
  Code (via its native Channels contract) and Codex (via its local app-server).
- **Safe by construction.** The control plane is the trust boundary; destructive
  prompts are described by deterministic code, and the approval path fails
  closed.
- **Self-hostable and open source (MIT).** Bring your own iMessage/SMS provider,
  database, and LLM key. Nothing is locked to a vendor.

## Features

- 📱 **Remote control over iMessage/SMS** — permission prompts, `AskUserQuestion`
  prompts, and `ExitPlanMode` plans are relayed to your phone the moment your
  session goes AFK.
- 🤖 **Claude Code *and* OpenAI Codex** — one plugin, two agents. Claude Code is
  driven through its built-in Channels contract; Codex (which has no equivalent)
  is hosted on its own app-server with replies injected over a WebSocket.
- 💬 **Natural-language replies** — say "yes, but skip the migration" and the
  orchestrator resolves your intent into a concrete `allow` / `deny` / answer.
- 🔒 **Deterministic safety gate** — destructive tools (Bash, network, unknown
  tools) are classified and described by code, never by the LLM, and unknown
  tools fail closed.
- 👍 **Tap-back binding** — a 👍/👎 tap-back on the exact notification binds to
  that request deterministically; the orchestrator refuses to guess when more
  than one request is pending.
- 🔋 **Keep-awake while AFK** — on macOS, an AFK session spawns `caffeinate` so an
  unattended Mac can't sleep and drop its iMessage bridge mid-run.
- 📤 **Durable outbox** — attention events survive restarts via an on-disk queue
  with exponential backoff; secrets are sanitized before anything leaves the
  device.
- 🧰 **Self-hostable stack** — Bun + TypeScript monorepo: Hono control plane
  (Fly.io), Next.js dashboard (Vercel), Neon Postgres, and a private LiteLLM
  proxy.

## How it works

You install a Claude Code / Codex **plugin** on your dev machine and pair it to a
**cloud control plane** with a one-time token. From then on:

**The core loop (AFK approval):** Claude Code opens a permission prompt → the
device hook/channel relays it to the control plane as an `attention_event` →
when the session is AFK, the orchestrator texts you → you reply → the
orchestrator resolves a `decision` → a Postgres `NOTIFY` wakes the device's
long-poll on `GET /api/device/decisions` → the device relays the verdict back to
Claude Code on the Channels permission notification (matched by `request_id`).

Codex works the same way from your side, but under the hood the plugin hosts
Codex's own local app-server and injects each inbound reply as an app-server
`turn/start` over a WebSocket — Codex has no Channels contract, so the plugin
recreates the same push/relay behavior itself.

## Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │                  Neon Postgres                 │
                 │  accounts · devices · pairing/onboarding_tokens│
                 │  conversations · sessions · attention_events   │
                 │  session_inbox (LISTEN/NOTIFY) · message_log    │
                 └──────────────────────────────────────────────┘
                        ▲                              ▲
            pg Pool /   │                              │  pg Pool
         LISTEN/NOTIFY  │                              │  (Better Auth + product)
                        │                              │
   ┌────────────────────┴───────────┐      ┌───────────┴───────────────────────┐
   │   apps/control-plane (Fly)      │      │   apps/dashboard (Vercel)          │
   │   Hono on Bun — stateless       │      │   Next.js 16 — Better Auth (Google)│
   │  • POST /api/sendblue/webhook   │      │  • Google SSO + invite-gated       │
   │    (URL-path secret auth)       │      │    onboarding wizard               │
   │  • getTransport() (Sendblue or  │      │  • Home: sessions, AFK toggle      │
   │    AgentPhone via MESSAGING_*)  │      │  • Integrations: mint pairing token│
   │  • orchestrator (LLM intent +   │      │  • same-origin /api/* BFF          │
   │    deterministic safety gate)   │      └────────────────────────────────────┘
   │  • device API (Bearer token):   │
   │    pair·attention·decisions     │
   │    ·heartbeat·state             │
   └───────▲─────────────────┬───────┘
           │ Sendblue/       │ device API (Bearer device_token,
           │ AgentPhone      │ long-poll decisions)
           │ send/webhook    │
  ┌────────┴───────┐   ┌──────────────────────────────────────────┐
  │  Sendblue or    │   │   packages/device (@imsg/device)          │
  │  AgentPhone     │   │   Claude Code + Codex plugin (dev machine)│
  │ iMessage / SMS  │   │  • channel MCP server (permission relay + │
  │   provider      │   │    `reply` chat bridge)                   │
  └────────┬───────┘   │  • PreToolUse/PermissionRequest hooks     │
           │            │  • Codex app-server host (WebSocket relay) │
        📱 phone        │  • imsg CLI (pair · afk · codex · status) │
                        │  • durable outbox + killswitch + sanitize │
                        └──────────────────────────────────────────┘

  Shared contract: packages/shared (@imsg/shared) — enums + types every
  package imports.  Transport port: packages/transport (@imsg/transport).
```

The orchestrator's LLM calls (intent classification, the assistant turn) go through
a private **LiteLLM proxy** (`apps/litellm`, deployed as its own Fly app and reached
over flycast at `http://imsg-litellm.flycast/v1`), which fronts Gemini (and
optionally Cerebras). The deterministic safety gate never depends on the LLM.

## Quick start

You need three things deployed (or pointed at): a **control plane**, a
**dashboard**, and a **device plugin** on your dev machine. The fastest path
once the control plane and dashboard are live:

1. Sign in to the dashboard with Google and complete the onboarding wizard.
2. On the **Integrations** page, copy the install one-liner (it embeds a
   single-use pairing token plus the two URLs the installer can't infer):

   ```sh
   curl -fsSL <dashboard-origin>/install.sh \
     | IMSG_INSTALL_BASE=<dashboard-origin> \
       IMSG_CONTROL_PLANE_URL=<control-plane> \
       TOKEN=<pairing-token> sh
   ```

3. Turn on AFK relay and start coding:

   ```sh
   imsg afk on        # route prompts to your phone
   imsg status
   # ...then run Claude Code as usual, or `imsg codex` for Codex
   ```

To stand the whole stack up yourself, see [Deployment](#deployment). For local
hacking, see [Local development](#local-development).

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
  device/          # @imsg/device — Claude Code + Codex plugin (channel MCP + hooks + CLI)
db/
  schema.sql       # Neon Postgres schema (incl. LISTEN/NOTIFY on session_inbox)
```

| Package              | Name                  | Role                                              |
| -------------------- | --------------------- | ------------------------------------------------- |
| `packages/shared`    | `@imsg/shared`        | Enums, const-objects, shared types (no deps)      |
| `packages/transport` | `@imsg/transport`     | Swappable messaging transport (Sendblue + AgentPhone) |
| `packages/device`    | `@imsg/device`        | Claude Code + Codex device plugin + `imsg` CLI    |
| `apps/control-plane` | `@imsg/control-plane` | Stateless app tier; all state in Neon             |
| `apps/dashboard`     | `@imsg/dashboard`     | Web UI (Better Auth, Google SSO, invite-gated)   |

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

## Configuration

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
`SSE_TICKET_SECRET` and `DATABASE_URL` are likewise shared between those two.

**Messaging provider** (`MESSAGING_PROVIDER`): Choose the SMS/iMessage transport:
- `sendblue` (default) — Sendblue API. Requires `SENDBLUE_API_KEY_ID`,
  `SENDBLUE_API_SECRET`, `SENDBLUE_WEBHOOK_SECRET`.
- `agentphone` — AgentPhone API (legacy). Requires `AGENTPHONE_API_KEY`,
  `AGENTPHONE_AGENT_ID`, `AGENTPHONE_WEBHOOK_SECRET`.

You also need the **Google OAuth client**, a **Neon database**, a **Gemini API key**
(for the LiteLLM proxy), and credentials for your chosen messaging provider.

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

**Device plugin** (on the machine where you use Claude Code / Codex):

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
chains the status line, pre-allows the `reply` tool, pairs the device, and aliases
`codex` to `imsg codex` (so Codex can receive inbound replies too). See
[`packages/device/README.md`](packages/device/README.md) for the device internals.

## Deployment

**1. Database — Neon**

- Create a Neon project; copy its connection string into `DATABASE_URL`.
- Apply the schema:

  ```sh
  psql "$DATABASE_URL" -f db/schema.sql
  ```

  This creates all product tables, the `session_inbox` / `session_state` /
  `device_state` LISTEN/NOTIFY triggers, and indexes. Better Auth's own tables
  (`user`, `session`, `account`, `verification` — its unprefixed defaults) are
  created separately by `bun run auth:migrate` from the dashboard.

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
  as a secret.) Point your messaging provider webhook at:
  - **Sendblue** (default): `https://<host>/api/sendblue/webhook/<SENDBLUE_WEBHOOK_SECRET>`
  - **AgentPhone** (legacy, opt-in): N/A — AgentPhone uses server-side polling
- `GET /healthz` (liveness) and `GET /readyz` (DB reachability) are available
  for Fly health checks.

**4. Dashboard — Vercel**

- Import `apps/dashboard` as the project root (Next.js, auto-detected).
- Set env vars in Vercel: `DATABASE_URL`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
  `CONTROL_PLANE_URL`, `DEVICE_TOKEN_PEPPER` (same value as the control plane),
  `SSE_TICKET_SECRET` (same value as the control plane), `WEBHOOK_BASE_URL`,
  `NEXT_PUBLIC_APP_URL`.
- The Google OAuth redirect URI is `${BETTER_AUTH_URL}/api/idp/callback/google`.
- New accounts must request access during onboarding (invite-gated flow);
  operator approval via email sets `access_status` to `approved`. Seed
  agent-number pool and configure `RESEND_API_KEY` for operator notification:

  ```sh
  cd apps/dashboard
  bun run scripts/seed-agent-numbers.ts
  # Set RESEND_API_KEY in env vars to enable operator email notifications
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

## Contributing

Contributions are welcome! This is a Bun + TypeScript monorepo:

```sh
bun install
bun run typecheck && bun run lint && bun test
```

Please run `typecheck`, `lint`, and `test` before opening a pull request, keep
changes scoped, and follow the existing conventions (enums in `@imsg/shared`,
strict TypeScript, no hardcoded strings where an enum fits). See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for details and
[`SECURITY.md`](SECURITY.md) to report a vulnerability privately.

## License

[MIT](LICENSE) © 2026 Probe
