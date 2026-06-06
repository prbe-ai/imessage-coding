# @imsg/device

The productized Claude Code channel plugin for **imessage-coding**. Drive Claude
Code from iMessage: while you're away from the keyboard (AFK), permission
prompts, questions, and plans are relayed to your phone — you approve, deny,
answer, or steer by text. Destructive operations stay **fail-closed**.

Productized from the validated Phase-0 spike (`plugins/imsg-spike`); the
localhost `:8799` control surface is replaced by calls to the cloud control
plane. Uses a durable outbox/backoff/creds/sanitize/killswitch design.

## What it does

- **Channel MCP server** (`src/channel.ts`) — implements the Claude Code
  Channels contract (`claude/channel` + `claude/channel/permission` + a `reply`
  tool). Permission prompts and relayed questions/plans become `AttentionEvent`s
  POSTed to `POST /api/device/attention`; verdicts/answers arrive
  by long-polling `GET /api/device/decisions`. Heartbeats + state mirror to the
  control plane. Auth is a Bearer `device_token` from the macOS Keychain (file
  fallback). Egress is gated by a fail-OPEN killswitch.
- **AFK-aware intercept hook** (`hooks/intercept.ts`) — `PreToolUse`
  (`AskUserQuestion`/`ExitPlanMode`) + `PermissionRequest` (`ExitPlanMode`).
  There is no standing auto-approval; every tool is gated per-action. When AFK,
  `AskUserQuestion` is held with instructions to relay via the `reply` tool and
  STOP, while `ExitPlanMode` is allowed to proceed (its tools stay gated).
- **Keep-awake while AFK** (`caffeinate.ts`) — on macOS, AFK-on spawns a detached
  `caffeinate -i -s` (prevents idle + system sleep, lets the display sleep) so an
  unattended Mac can't drop its network/iMessage bridge mid-session; AFK-off kills
  it. Tracked by `caffeinate.pid`, reconciled at both AFK write sites (CLI + the
  remote down-push) AND on channel-server startup (self-heals to the current AFK
  state, so a session that boots — or a reinstall — while already AFK is covered),
  idempotent, and a no-op off macOS.
- **CLI** (`bin/imsg.ts`) — `pair <token>`, `afk on|off|toggle`, `status`,
  `statusline`.

## Install

One-liner — copy it from the dashboard's Integrations page. It embeds a
single-use pairing token plus the two URLs the piped installer can't infer:
`IMSG_INSTALL_BASE` (where to download the plugin) and `IMSG_CONTROL_PLANE_URL`
(which control plane to pair against):

```bash
curl -fsSL https://msg.example.com/install.sh \
  | IMSG_INSTALL_BASE=https://msg.example.com \
    IMSG_CONTROL_PLANE_URL=https://api.msg.example.com \
    TOKEN=<pairing-token> sh
```

To install from a local checkout instead, run `packages/device/install.sh`
directly (it infers the source from its own path) or set `IMSG_DEVICE_SRC`.

`install.sh` resolves bun's absolute path, obtains the plugin source (downloads
`imsg-device.tar.gz` from `IMSG_INSTALL_BASE` when piped; uses the on-disk
source when run as a file), stages it into a local marketplace, `bun install`s
deps, registers + `claude plugin enable
imsg-device@imsg`, rewrites the bare `bun` command to the absolute path in
`.mcp.json` + `hooks/hooks.json`, wrap-chains the statusLine into
`~/.claude/settings.json` (backing up first), pre-allows the `mcp__imsg-device__reply`
tool so relaying never prompts, and exchanges the pairing token for a
`device_token`.

## State + config

All mutable state lives under `IMSG_DEVICE_DIR` (default `~/.imsg/`) — a neutral,
agent-agnostic folder (NOT nested under `~/.claude/`) so Claude Code and other
agents (e.g. Codex) share one machine-wide AFK switch and one logs location. It's
separate from the plugin code root (`CLAUDE_PLUGIN_ROOT`) so a reinstall never
clobbers your token. State written by versions before 0.1.7 under
`~/.claude/plugins/imsg-device/` is relocated here on first run (non-destructive
copy; the legacy dir is left intact).

- `.token` (0600) + Keychain — the `device_token`
- `afk.state` / `pending.state` — fast local state the hook +
  statusline read
- `caffeinate.pid` — pid of the keep-awake process held while AFK is on (macOS)
- `outbox.jsonl` — durable attention-event queue (exponential backoff, cap 300s)
- `sessions/` — per-session tap state (cursor, activity outbox, title, pid)
- `logs/` — channel + hook + per-session tap logs (token never logged)

### Env

| Var | Default | Purpose |
| --- | --- | --- |
| `IMSG_CONTROL_PLANE_URL` | `http://localhost:8080` | control plane base URL |
| `IMSG_DEVICE_DIR` | `~/.imsg` | mutable state dir (neutral, agent-agnostic) |
| `IMSG_DEVICE_TOKEN` | — | override the device token (CI/testing) |
| `IMSG_SESSION_ID` | random uuid | session id for the channel server |

## Safety invariants

- The **approval path is fail-CLOSED**: with no decision, NO verdict is sent —
  Claude Code's own prompt stays the only authority. The channel server only
  relays a verdict it explicitly received and can bind to a `request_id`.
- The **killswitch is fail-OPEN** but governs ONLY egress (attention posting +
  heartbeat), never permission verdicts. Egress and approval are deliberately
  separate code paths.
- All previewed text (descriptions, input previews, reply text) is **sanitized**
  for secrets and length-capped before leaving the device.
