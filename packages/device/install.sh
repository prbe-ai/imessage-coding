#!/usr/bin/env bash
# =============================================================================
# imsg-device installer — one-liner for the imessage-coding device plugin.
#
#   curl -fsSL https://msg.example.com/install.sh | TOKEN=<pairing-token> sh
#
# What it does, in order:
#   1. Resolve bun's ABSOLUTE path (command -v bun) — required so the plugin's
#      MCP server + hooks run with a fully-qualified interpreter regardless of
#      the user's PATH when Claude Code spawns them.
#   2. Stage the plugin into an imsg-device/ subdir of a local marketplace,
#      generate the catalog (plugin source ./imsg-device), and `bun install`.
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
#   IMSG_CONTROL_PLANE_URL   control-plane base URL (default http://localhost:8080).
#                            The minted install one-liner sets this to the real
#                            control-plane host so piped installs don't pair
#                            against localhost.
#   IMSG_INSTALL_BASE        dashboard origin that served this script (e.g.
#                            https://msg.example.com). When piped (curl | sh) with
#                            no IMSG_DEVICE_SRC, the plugin is fetched from
#                            ${IMSG_INSTALL_BASE}/imsg-device.tar.gz — this is what
#                            makes the one-liner self-contained. The minted
#                            install one-liner sets it automatically.
#   IMSG_DEVICE_SRC          source dir to install FROM. When run as a local file,
#                            defaults to the script's own dir; set it to install
#                            from a checkout instead of downloading the tarball.
#
# Runs under both bash and a POSIX `sh` (the documented `| sh` invocation), so it
# avoids bashisms (no `set -o pipefail`, no ${BASH_SOURCE[@]}).
# =============================================================================
set -eu

CONTROL_PLANE_URL="${IMSG_CONTROL_PLANE_URL:-http://localhost:8080}"
PLUGIN_NAME="imsg-device"
MARKETPLACE_NAME="imsg"
CLAUDE_DIR="${HOME}/.claude"
SETTINGS="${CLAUDE_DIR}/settings.json"
# Mutable state dir (matches src/config.ts deviceDir()); survives reinstalls.
DEVICE_DIR="${IMSG_DEVICE_DIR:-${CLAUDE_DIR}/plugins/${PLUGIN_NAME}}"
# Where we stage the plugin code as a local single-plugin marketplace.
MARKETPLACE_DIR="${CLAUDE_DIR}/plugins/marketplaces/${MARKETPLACE_NAME}"
# Claude Code requires a marketplace plugin `source` to be a SUBDIRECTORY
# ("./imsg-device"); a root source (".") is rejected as an unsupported source
# type. So the plugin code lives in this subdir and a generated catalog at the
# marketplace root points at it.
PLUGIN_DIR="${MARKETPLACE_DIR}/${PLUGIN_NAME}"

say() { printf '[imsg-install] %s\n' "$*"; }
die() { printf '[imsg-install] error: %s\n' "$*" >&2; exit 1; }

# --- 1. resolve bun ----------------------------------------------------------
BUN="$(command -v bun || true)"
[ -n "$BUN" ] || die "bun not found on PATH. Install bun (https://bun.sh) and re-run."
# Canonicalize to a stable absolute path (handles shims / symlinks).
BUN="$(cd "$(dirname "$BUN")" && pwd)/$(basename "$BUN")"
say "using bun: $BUN"

# Source dir: where the packaged plugin lives. Resolved in priority order:
#  1. Explicit IMSG_DEVICE_SRC — install from a local checkout.
#  2. This script's own dir — but ONLY when invoked as a real on-disk file.
#     Under `curl ... | sh`, $0 is the shell name ("sh"/"dash"), not a path, and
#     BASH_SOURCE is unset, so this branch can't fire for a piped install.
#  3. Piped with no local source: download the plugin tarball from the dashboard
#     origin (IMSG_INSTALL_BASE) into a temp dir. This is what makes the
#     advertised `curl ... | sh` one-liner self-contained — without it a pipe
#     has only the script, never the plugin code.
# We never fall back to the cwd (that would silently stage the wrong tree).
SRC="${IMSG_DEVICE_SRC:-}"
if [ -z "$SRC" ]; then
  if [ -f "$0" ]; then
    SRC="$(cd "$(dirname "$0")" && pwd)"
  elif [ -n "${IMSG_INSTALL_BASE:-}" ]; then
    command -v curl >/dev/null 2>&1 || die "curl not found — needed to download the plugin"
    command -v tar  >/dev/null 2>&1 || die "tar not found — needed to unpack the plugin"
    TARBALL_URL="${IMSG_INSTALL_BASE%/}/imsg-device.tar.gz"
    SRC="$(mktemp -d)"
    TARBALL_TMP="$(mktemp)"
    say "fetching plugin from $TARBALL_URL"
    # Download to a file, THEN extract — not `curl | tar`. A POSIX `sh` has no
    # pipefail, and an empty/failed curl body makes tar exit 0 on some platforms,
    # so a piped download failure would be silently masked. Separating the two
    # steps fails closed with a precise error.
    curl -fsSL "$TARBALL_URL" -o "$TARBALL_TMP" \
      || die "could not download the plugin from $TARBALL_URL"
    ( cd "$SRC" && tar -xzf "$TARBALL_TMP" ) \
      || die "could not unpack the plugin tarball from $TARBALL_URL"
    rm -f "$TARBALL_TMP"
  else
    die "running from a pipe (curl | sh) without IMSG_INSTALL_BASE — re-copy the install command from the dashboard, or set IMSG_DEVICE_SRC to a local checkout of packages/device"
  fi
fi
[ -f "$SRC/.claude-plugin/plugin.json" ] || die "no plugin.json under $SRC — set IMSG_DEVICE_SRC"

# Resolve the Claude CLI up front. `claude plugin marketplace remove` DELETES the
# marketplace's install directory ($MARKETPLACE_DIR is a CC-managed dir), so clear
# any stale registration HERE — BEFORE we stage into that same dir. Doing it after
# staging would wipe the freshly-staged plugin and break pairing.
CLAUDE_BIN="$(command -v claude || true)"
if [ -n "$CLAUDE_BIN" ]; then
  "$CLAUDE_BIN" plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
fi

# --- 2. stage the plugin (in a subdir) + generate the catalog + install deps -
# Lay out the marketplace the way Claude Code expects:
#   $MARKETPLACE_DIR/.claude-plugin/marketplace.json   (catalog; source ./imsg-device)
#   $MARKETPLACE_DIR/imsg-device/<the plugin>          (staged here, NOT at root)
# A re-install must re-stage cleanly, so wipe any prior plugin subdir first.
say "staging plugin into $PLUGIN_DIR"
rm -rf "$PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR" "$MARKETPLACE_DIR/.claude-plugin" "$DEVICE_DIR"
# Copy code (excluding any local state / node_modules from the source tree).
( cd "$SRC" && tar --exclude=node_modules --exclude=logs --exclude='.token' -cf - . ) \
  | ( cd "$PLUGIN_DIR" && tar -xf - )

# Build the root catalog from the plugin's bundled marketplace.json, rewriting
# the plugin `source` from "." to the "./imsg-device" subdir CC accepts, then
# drop the inner copy (the root catalog is authoritative).
INNER_MKT="$PLUGIN_DIR/.claude-plugin/marketplace.json"
[ -f "$INNER_MKT" ] || die "no marketplace.json under $PLUGIN_DIR/.claude-plugin — bad plugin package"
PLUGIN_SUBDIR="$PLUGIN_NAME" "$BUN" -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const sub = "./" + process.env.PLUGIN_SUBDIR;
  for (const p of (m.plugins || [])) {
    if (p && (p.source === undefined || p.source === "." || p.source === "./")) p.source = sub;
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(m, null, 2) + "\n");
' "$INNER_MKT" "$MARKETPLACE_DIR/.claude-plugin/marketplace.json"
rm -f "$INNER_MKT"

# Ensure @imsg/shared is vendored + resolvable. The dashboard tarball ships it
# pre-vendored (vendor/shared + a `file:` dep). A raw monorepo checkout still
# carries `workspace:*`, which a standalone `bun install` (run outside the
# workspace root we just staged into) can't resolve — so vendor it from the
# sibling packages/shared. No-op for the tarball (already a `file:` dep).
NEEDS_VENDOR="$("$BUN" -e '
  const fs = require("fs");
  let p = {};
  try { p = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
  const v = (p.dependencies || {})["@imsg/shared"] || "";
  process.stdout.write(v.indexOf("workspace:") === 0 ? "1" : "0");
' "$PLUGIN_DIR/package.json")"
if [ "$NEEDS_VENDOR" = "1" ]; then
  if [ ! -f "$PLUGIN_DIR/vendor/shared/package.json" ]; then
    if [ -f "$SRC/../shared/package.json" ]; then
      mkdir -p "$PLUGIN_DIR/vendor/shared"
      ( cd "$SRC/../shared" && tar --exclude=node_modules --exclude=logs -cf - . ) \
        | ( cd "$PLUGIN_DIR/vendor/shared" && tar -xf - )
    else
      die "@imsg/shared (workspace dep) not found to vendor — install via the dashboard one-liner, or run from a full monorepo checkout"
    fi
  fi
  "$BUN" -e '
    const fs = require("fs");
    const f = process.argv[1];
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    p.dependencies["@imsg/shared"] = "file:./vendor/shared";
    fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
  ' "$PLUGIN_DIR/package.json"
  say "vendored @imsg/shared from the checkout (workspace dep -> file:)"
fi

say "installing dependencies with bun"
( cd "$PLUGIN_DIR" && "$BUN" install --production ) || die "bun install failed"

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
rewrite_bun "$PLUGIN_DIR/.mcp.json"
rewrite_bun "$PLUGIN_DIR/hooks/hooks.json"
say "rewrote bun command to absolute path in .mcp.json + hooks.json"

# --- 4. register marketplace + enable plugin --------------------------------
# CLAUDE_BIN resolved above (where the stale marketplace was removed pre-staging).
if [ -n "$CLAUDE_BIN" ]; then
  say "registering marketplace + installing plugin"
  "$CLAUDE_BIN" plugin marketplace add "$MARKETPLACE_DIR" >/dev/null 2>&1 || true
  # `install` downloads/caches + enables; `enable` only flips an already-installed
  # plugin, so it would NOT cache ours (and the plugin would never load).
  "$CLAUDE_BIN" plugin install "${PLUGIN_NAME}@${MARKETPLACE_NAME}" >/dev/null 2>&1 \
    || say "note: could not auto-install; run: claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
else
  say "note: 'claude' CLI not on PATH — install manually with:"
  say "  claude plugin marketplace add $MARKETPLACE_DIR"
  say "  claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
fi

# --- 5/6. wrap-chain statusLine + pre-allow the reply tool in settings.json --
# Done in one bun pass: back up the existing settings, chain any prior statusLine
# command in front of ours (so we don't clobber a user's bar), and add the MCP
# reply tool to permissions.allow.
mkdir -p "$CLAUDE_DIR"
[ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"
BACKUP="${SETTINGS}.imsg-backup"
[ -f "$BACKUP" ] || cp "$SETTINGS" "$BACKUP"

STATUSLINE_CMD="$BUN ${PLUGIN_DIR}/bin/imsg.ts statusline"
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
    "$BUN" "${PLUGIN_DIR}/bin/imsg.ts" pair "$TOKEN" \
    || die "pairing failed — request a fresh token from the dashboard and re-run"
else
  say "no TOKEN provided — pair later with:"
  say "  $BUN ${PLUGIN_DIR}/bin/imsg.ts pair <pairing-token>"
fi

say "done. Restart Claude Code (or start a new session) to load the plugin."
