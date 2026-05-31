#!/usr/bin/env bash
# =============================================================================
# imsg-device installer — one-liner for the imessage-coding device plugin.
#
#   curl -fsSL https://message.prbe.ai/install.sh | TOKEN=<pairing-token> sh
#
# What it does, in order:
#   1. Resolve bun's ABSOLUTE path (command -v bun) — required so the plugin's
#      MCP server + hooks run with a fully-qualified interpreter regardless of
#      the user's PATH when Claude Code spawns them.
#   2. Stage the plugin into a local marketplace dir and `bun install` its deps.
#   3. Register the marketplace + `claude plugin enable imsg-device@imsg`.
#   4. Rewrite the shipped bare `bun` command in .mcp.json + hooks.json to the
#      resolved absolute path.
#   5. Wrap-and-chain the plugin statusLine into ~/.claude/settings.json,
#      backing up the prior file first (restorable on uninstall).
#   6. Pre-allow the channel MCP `reply` tool in permissions.allow so the agent
#      never gets a permission prompt for relaying to the phone.
#   7. Exchange the single-use pairing TOKEN immediately for a device_token.
#
# Env:
#   TOKEN                    single-use pairing token (required to pair)
#   IMSG_CONTROL_PLANE_URL   control-plane base URL (default https://message.prbe.ai)
#   IMSG_DEVICE_SRC          source dir to install FROM. REQUIRED when this script
#                            is piped to `sh` (curl | sh), where there is no
#                            on-disk script path to infer the source from. When
#                            run as a local file, defaults to the script's dir.
#
# Runs under both bash and a POSIX `sh` (the documented `| sh` invocation), so it
# avoids bashisms (no `set -o pipefail`, no ${BASH_SOURCE[@]}).
# =============================================================================
set -eu

CONTROL_PLANE_URL="${IMSG_CONTROL_PLANE_URL:-https://message.prbe.ai}"
PLUGIN_NAME="imsg-device"
MARKETPLACE_NAME="imsg"
CLAUDE_DIR="${HOME}/.claude"
SETTINGS="${CLAUDE_DIR}/settings.json"
# Mutable state dir (matches src/config.ts deviceDir()); survives reinstalls.
DEVICE_DIR="${IMSG_DEVICE_DIR:-${CLAUDE_DIR}/plugins/${PLUGIN_NAME}}"
# Where we stage the plugin code as a local single-plugin marketplace.
MARKETPLACE_DIR="${CLAUDE_DIR}/plugins/marketplaces/${MARKETPLACE_NAME}"

say() { printf '[imsg-install] %s\n' "$*"; }
die() { printf '[imsg-install] error: %s\n' "$*" >&2; exit 1; }

# --- 1. resolve bun ----------------------------------------------------------
BUN="$(command -v bun || true)"
[ -n "$BUN" ] || die "bun not found on PATH. Install bun (https://bun.sh) and re-run."
# Canonicalize to a stable absolute path (handles shims / symlinks).
BUN="$(cd "$(dirname "$BUN")" && pwd)/$(basename "$BUN")"
say "using bun: $BUN"

# Source dir: where the packaged plugin lives.
#  - Explicit IMSG_DEVICE_SRC always wins.
#  - Otherwise, infer from this script's own path — but ONLY when invoked as a
#    real file. Under `curl ... | sh`, there is no script file ($0 is the shell
#    name like "sh"/"dash", and BASH_SOURCE is unset), so we MUST be told the
#    source dir. We never fall back to the cwd (that would silently stage the
#    wrong tree).
SRC="${IMSG_DEVICE_SRC:-}"
if [ -z "$SRC" ]; then
  # $0 is a usable path only when it resolves to an existing file (not piped).
  if [ -f "$0" ]; then
    SRC="$(cd "$(dirname "$0")" && pwd)"
  else
    die "running from a pipe (curl | sh) — set IMSG_DEVICE_SRC to the plugin source dir"
  fi
fi
[ -f "$SRC/.claude-plugin/plugin.json" ] || die "no plugin.json under $SRC — set IMSG_DEVICE_SRC"

# --- 2. stage the plugin + install deps -------------------------------------
say "staging plugin into $MARKETPLACE_DIR"
mkdir -p "$MARKETPLACE_DIR" "$DEVICE_DIR"
# Copy code (excluding any local state / node_modules from the source tree).
( cd "$SRC" && tar --exclude=node_modules --exclude=logs --exclude='.token' -cf - . ) \
  | ( cd "$MARKETPLACE_DIR" && tar -xf - )

say "installing dependencies with bun"
( cd "$MARKETPLACE_DIR" && "$BUN" install --production ) || die "bun install failed"

# --- 3. rewrite bare 'bun' -> absolute path in MCP + hooks -------------------
# Claude Code expands ${CLAUDE_PLUGIN_ROOT}; we only need the interpreter to be
# absolute. Use bun itself to rewrite JSON safely (no jq dependency).
rewrite_bun() {
  local file="$1"
  [ -f "$file" ] || return 0
  BUN_ABS="$BUN" "$BUN" -e '
    const fs = require("fs");
    const f = process.argv[1];
    const bun = process.env.BUN_ABS;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const walk = (o) => {
      if (Array.isArray(o)) return o.map(walk);
      if (o && typeof o === "object") {
        for (const k of Object.keys(o)) {
          if (k === "command" && o[k] === "bun") o[k] = bun;
          else if (k === "command" && typeof o[k] === "string" && o[k].startsWith("bun "))
            o[k] = bun + o[k].slice(3);
          else o[k] = walk(o[k]);
        }
        return o;
      }
      return o;
    };
    fs.writeFileSync(f, JSON.stringify(walk(j), null, 2) + "\n");
  ' "$file"
}
rewrite_bun "$MARKETPLACE_DIR/.mcp.json"
rewrite_bun "$MARKETPLACE_DIR/hooks/hooks.json"
say "rewrote bun command to absolute path in .mcp.json + hooks.json"

# --- 4. register marketplace + enable plugin --------------------------------
CLAUDE_BIN="$(command -v claude || true)"
if [ -n "$CLAUDE_BIN" ]; then
  say "registering marketplace + enabling plugin"
  "$CLAUDE_BIN" plugin marketplace add "$MARKETPLACE_DIR" >/dev/null 2>&1 || true
  "$CLAUDE_BIN" plugin enable "${PLUGIN_NAME}@${MARKETPLACE_NAME}" >/dev/null 2>&1 \
    || say "note: could not auto-enable; run: claude plugin enable ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
else
  say "note: 'claude' CLI not on PATH — enable manually with:"
  say "  claude plugin marketplace add $MARKETPLACE_DIR"
  say "  claude plugin enable ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
fi

# --- 5/6. wrap-chain statusLine + pre-allow the reply tool in settings.json --
# Done in one bun pass: back up the existing settings, chain any prior statusLine
# command in front of ours (so we don't clobber a user's bar), and add the MCP
# reply tool to permissions.allow.
mkdir -p "$CLAUDE_DIR"
[ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"
BACKUP="${SETTINGS}.imsg-backup"
[ -f "$BACKUP" ] || cp "$SETTINGS" "$BACKUP"

STATUSLINE_CMD="$BUN ${MARKETPLACE_DIR}/bin/imsg.ts statusline"
REPLY_PERMISSION="mcp__${PLUGIN_NAME}__reply"

SETTINGS_FILE="$SETTINGS" STATUSLINE_CMD="$STATUSLINE_CMD" REPLY_PERMISSION="$REPLY_PERMISSION" \
  "$BUN" -e '
  const fs = require("fs");
  const f = process.env.SETTINGS_FILE;
  const ours = process.env.STATUSLINE_CMD;
  const reply = process.env.REPLY_PERMISSION;
  let s = {};
  try { s = JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch {}

  // ----- statusLine wrap-chain -----
  // Marker so a re-install is idempotent (replace our own, keep the users prefix).
  const MARK = "# imsg-device statusline";
  const prev = s.statusLine;
  let prefix = "";
  if (prev && typeof prev === "object" && typeof prev.command === "string") {
    const c = prev.command;
    if (c.includes(MARK)) {
      // Our own chained command from a prior install: strip our suffix, keep prefix.
      const idx = c.indexOf("; " + ours);
      prefix = idx >= 0 ? c.slice(0, idx) : "";
    } else {
      prefix = c; // a real user statusline — chain it in front of ours
    }
  }
  const chained = prefix ? (prefix + "; " + ours + " " + MARK) : (ours + " " + MARK);
  s.statusLine = { type: "command", command: chained };

  // ----- pre-allow the reply MCP tool so relaying never prompts -----
  s.permissions = s.permissions || {};
  s.permissions.allow = Array.isArray(s.permissions.allow) ? s.permissions.allow : [];
  if (!s.permissions.allow.includes(reply)) s.permissions.allow.push(reply);

  fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
'
say "wrap-chained statusLine + pre-allowed $REPLY_PERMISSION (backup: $BACKUP)"

# --- 7. pair --------------------------------------------------------------
if [ -n "${TOKEN:-}" ]; then
  say "pairing device with the control plane"
  IMSG_CONTROL_PLANE_URL="$CONTROL_PLANE_URL" IMSG_DEVICE_DIR="$DEVICE_DIR" \
    "$BUN" "${MARKETPLACE_DIR}/bin/imsg.ts" pair "$TOKEN" \
    || die "pairing failed — request a fresh token from the dashboard and re-run"
else
  say "no TOKEN provided — pair later with:"
  say "  $BUN ${MARKETPLACE_DIR}/bin/imsg.ts pair <pairing-token>"
fi

say "done. Restart Claude Code (or start a new session) to load the plugin."
