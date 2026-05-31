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
  POSTed to `POST /api/device/attention`; verdicts/answers/grant changes arrive
  by long-polling `GET /api/device/decisions`. Heartbeats + state mirror to the
  control plane. Auth is a Bearer `device_token` from the macOS Keychain (file
  fallback). Egress is gated by a fail-OPEN killswitch.
- **AFK-aware intercept hook** (`hooks/intercept.ts`) — `PreToolUse`
  (`AskUserQuestion`/`ExitPlanMode`) + `PermissionRequest` (`ExitPlanMode`).
  Session grant auto-approves edits (`edits`) or everything (`full`), but never
  Bash under `edits` (fail-closed). When AFK, question/plan tools are held with
  instructions to relay via the `reply` tool and STOP. A session grant is the
  cloud-side "plan approved" signal that releases `ExitPlanMode`.
- **CLI** (`bin/imsg.ts`) — `pair <token>`, `afk on|off|toggle`,
  `grant edits|full|off`, `status`, `statusline`.

## Install

One-liner (embeds a single-use pairing token from the dashboard):

```bash
curl -fsSL https://msg.example.com/install.sh | TOKEN=<pairing-token> sh
```

`install.sh` resolves bun's absolute path, stages the plugin into a local
marketplace, `bun install`s deps, registers + `claude plugin enable
imsg-device@imsg`, rewrites the bare `bun` command to the absolute path in
`.mcp.json` + `hooks/hooks.json`, wrap-chains the statusLine into
`~/.claude/settings.json` (backing up first), pre-allows the `mcp__imsg-device__reply`
tool so relaying never prompts, and exchanges the pairing token for a
`device_token`.

## State + config

All mutable state lives under `IMSG_DEVICE_DIR` (default
`~/.claude/plugins/imsg-device/`), separate from the plugin code root
(`CLAUDE_PLUGIN_ROOT`) so a reinstall never clobbers your token:

- `.token` (0600) + Keychain — the `device_token`
- `afk.state` / `grant.state` / `pending.state` — fast local state the hook +
  statusline read
- `outbox.jsonl` — durable attention-event queue (exponential backoff, cap 300s)
- `logs/` — channel + hook logs (token never logged)

### Env

| Var | Default | Purpose |
| --- | --- | --- |
| `IMSG_CONTROL_PLANE_URL` | `http://localhost:8080` | control plane base URL |
| `IMSG_DEVICE_DIR` | `~/.claude/plugins/imsg-device` | mutable state dir |
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
