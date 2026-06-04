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
#   8. Alias `claude` (in ~/.zshrc / ~/.bashrc) to launch with the channels flag
#      (--dangerously-load-development-channels), required for the AFK permission
#      relay. Revertable via uninstall.sh (marker-wrapped block).
#
# Env (all OPTIONAL — the served script bakes its own defaults; the canonical
# one-liner is just `curl -fsSL .../install.sh | TOKEN=<token> sh`):
#   TOKEN                    single-use pairing token (required to pair)
#   IMSG_CONTROL_PLANE_URL   override the control-plane base URL. Not needed for a
#                            normal install: the URL is baked into the plugin
#                            (build-config.json) so pairing AND the runtime read
#                            it without any env. Set only to point at a different
#                            control plane (e.g. local dev).
#   IMSG_INSTALL_BASE        override the origin the plugin tarball is fetched
#                            from. Not needed normally: the build bakes the
#                            dashboard origin into the SERVED copy of this script
#                            (the default assignment near the top). Set only to
#                            fetch the tarball from a different host.
#   IMSG_DEVICE_SRC          source dir to install FROM. When run as a local file,
#                            defaults to the script's own dir; set it to install
#                            from a checkout instead of downloading the tarball.
#
# Runs under both bash and a POSIX `sh` (the documented `| sh` invocation), so it
# avoids bashisms (no `set -o pipefail`, no ${BASH_SOURCE[@]}).
# =============================================================================
set -eu

# Origin that serves this script + the plugin tarball. copy-install-script.mjs
# bakes the dashboard origin into the SERVED copy by replacing the placeholder
# token below, so the piped one-liner needn't pass IMSG_INSTALL_BASE. An explicit
# env value still wins. The source tree keeps the placeholder verbatim — that's
# fine: local-file installs infer the source from $0 and never read this.
IMSG_INSTALL_BASE="${IMSG_INSTALL_BASE:-__IMSG_INSTALL_BASE__}"
PLUGIN_NAME="imsg-device"
MARKETPLACE_NAME="imsg"
# Which coding agent to install the plugin for. DEFAULT both: set up every agent
# present on this machine. The Codex path SELF-SKIPS when the `codex` CLI is not
# installed, so a Claude-Code-only machine gets exactly the CC install and no
# stray ~/.codex artifacts. Override with IMSG_AGENT_TARGET=claude-code or =codex
# for a single-agent install.
#   claude-code | codex | both
IMSG_AGENT_TARGET="${IMSG_AGENT_TARGET:-both}"
CLAUDE_DIR="${HOME}/.claude"
SETTINGS="${CLAUDE_DIR}/settings.json"
# Mutable state dir (matches src/config.ts deviceDir()): the neutral,
# agent-agnostic ~/.imsg so Claude Code + other agents (e.g. Codex) share one
# machine-wide AFK switch + logs location. Survives reinstalls. The plugin's own
# migrateLegacyDeviceDir() relocates pre-0.1.7 state from ~/.claude/plugins/.
DEVICE_DIR="${IMSG_DEVICE_DIR:-${HOME}/.imsg}"
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
[ -f "$SRC/.claude-plugin/plugin.json" ] || [ -f "$SRC/.codex-plugin/plugin.json" ] \
  || die "no plugin.json under $SRC/.claude-plugin or $SRC/.codex-plugin — set IMSG_DEVICE_SRC"

# Normalize + validate the install target.
case "$IMSG_AGENT_TARGET" in
  claude-code|codex|both) : ;;
  *) die "IMSG_AGENT_TARGET must be one of: claude-code | codex | both (got '$IMSG_AGENT_TARGET')" ;;
esac
say "install target: $IMSG_AGENT_TARGET"

# Shared @imsg/shared vendoring: a raw monorepo checkout carries `workspace:*` for
# @imsg/shared, which a standalone `bun install` can't resolve. Vendor it from the
# sibling packages/shared and rewrite the dep to `file:`. No-op for the dashboard
# tarball (already a `file:` dep). Called by each target after staging into its dir.
vendor_shared() {
  plugin_dir="$1"
  NEEDS_VENDOR="$("$BUN" -e '
    const fs = require("fs");
    let p = {};
    try { p = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
    const v = (p.dependencies || {})["@imsg/shared"] || "";
    process.stdout.write(v.indexOf("workspace:") === 0 ? "1" : "0");
  ' "$plugin_dir/package.json")"
  if [ "$NEEDS_VENDOR" = "1" ]; then
    if [ ! -f "$plugin_dir/vendor/shared/package.json" ]; then
      if [ -f "$SRC/../shared/package.json" ]; then
        mkdir -p "$plugin_dir/vendor/shared"
        ( cd "$SRC/../shared" && tar --exclude=node_modules --exclude=logs -cf - . ) \
          | ( cd "$plugin_dir/vendor/shared" && tar -xf - )
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
    ' "$plugin_dir/package.json"
    say "vendored @imsg/shared into $plugin_dir (workspace dep -> file:)"
  fi
}

# Shared: rewrite the shipped bare `bun` command to the resolved absolute path in
# a JSON file (MCP + hooks). Claude Code/Codex expand ${CLAUDE_PLUGIN_ROOT}; we
# only need the interpreter to be absolute. Uses bun itself (no jq dependency).
rewrite_bun() {
  file="$1"
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

# =============================================================================
# Shared: bake the control-plane URL into a staged plugin dir (build-config.json)
# for LOCAL/checkout installs. The SERVED tarball already carries this file
# (apps/dashboard/scripts/copy-install-script.mjs writes it at build time); a raw
# checkout does NOT, so without it the plugin's config.ts controlPlaneUrl() falls
# back to localhost:8080 — Claude Code AND Codex spawn the hooks + MCP server with
# no env, so the baked file is the only runtime URL source. Writes ONLY when a URL
# is provided AND the file is absent (never clobber a tarball-baked value). The
# `if [ ] && [ ]` form is deliberate: a bare `test && cmd` statement would abort
# the script under `set -e` when the test is false.
# =============================================================================
bake_build_config() {
  _bbc_dir="$1"
  _bbc_url="${IMSG_CONTROL_PLANE_URL:-${CONTROL_PLANE_URL:-}}"
  if [ -n "$_bbc_url" ] && [ ! -f "$_bbc_dir/build-config.json" ]; then
    _bbc_url="${_bbc_url%/}"
    printf '{\n  "controlPlaneUrl": "%s"\n}\n' "$_bbc_url" > "$_bbc_dir/build-config.json"
    say "baked control-plane URL into build-config.json ($_bbc_url)"
  fi
}

# =============================================================================
# Shared: pair the device with the control plane (idempotent across targets —
# both agents share ONE ~/.imsg device dir + token, so we pair exactly once).
# =============================================================================
PAIRED=""
pair_device() {
  pair_bin="$1" # path to a staged bin/imsg.ts (either target's copy works)
  [ -n "$PAIRED" ] && return 0
  if [ -z "${TOKEN:-}" ]; then
    say "no TOKEN provided — pair later with:"
    say "  $BUN ${pair_bin} pair <pairing-token>"
    return 0
  fi
  say "pairing device with the control plane"
  # Pass IMSG_CONTROL_PLANE_URL through ONLY if the operator set it explicitly;
  # otherwise let the CLI read the control-plane URL baked into the plugin
  # (build-config.json) instead of forcing a localhost default.
  if [ -n "${IMSG_CONTROL_PLANE_URL:-}" ]; then
    IMSG_CONTROL_PLANE_URL="$IMSG_CONTROL_PLANE_URL" IMSG_DEVICE_DIR="$DEVICE_DIR" \
      "$BUN" "${pair_bin}" pair "$TOKEN" \
      || die "pairing failed — request a fresh token from the dashboard and re-run"
  else
    IMSG_DEVICE_DIR="$DEVICE_DIR" \
      "$BUN" "${pair_bin}" pair "$TOKEN" \
      || die "pairing failed — request a fresh token from the dashboard and re-run"
  fi
  PAIRED="1"
}

# =============================================================================
# Claude Code target — the original install path, UNCHANGED in behavior.
# =============================================================================
install_for_claude_code() {
  CLAUDE_BIN="$(command -v claude || true)"
  # `claude plugin marketplace remove` DELETES the marketplace install dir, so
  # clear any stale registration BEFORE we stage into that same dir.
  if [ -n "$CLAUDE_BIN" ]; then
    "$CLAUDE_BIN" plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
  fi

  # --- 2. stage the plugin (in a subdir) + generate the catalog + install deps -
  #   $MARKETPLACE_DIR/.claude-plugin/marketplace.json   (catalog; source ./imsg-device)
  #   $MARKETPLACE_DIR/imsg-device/<the plugin>          (staged here, NOT at root)
  say "staging Claude Code plugin into $PLUGIN_DIR"
  rm -rf "$PLUGIN_DIR"
  mkdir -p "$PLUGIN_DIR" "$MARKETPLACE_DIR/.claude-plugin" "$DEVICE_DIR"
  ( cd "$SRC" && tar --exclude=node_modules --exclude=logs --exclude='.token' -cf - . ) \
    | ( cd "$PLUGIN_DIR" && tar -xf - )

  # Build the root catalog from the plugin's bundled marketplace.json, rewriting
  # the plugin `source` "." -> "./imsg-device" subdir CC accepts; drop the inner copy.
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
  # The CC plugin never loads the Codex-only manifests/hooks; drop them so they
  # don't confuse CC's loader (it would otherwise see two marketplace.json files).
  rm -rf "$PLUGIN_DIR/.codex-plugin" "$PLUGIN_DIR/hooks/codex" "$PLUGIN_DIR/commands/codex" \
         "$PLUGIN_DIR/.mcp.codex.json"

  vendor_shared "$PLUGIN_DIR"
  bake_build_config "$PLUGIN_DIR"
  say "installing dependencies with bun"
  ( cd "$PLUGIN_DIR" && "$BUN" install --production ) || die "bun install failed"

  # --- 3. rewrite bare 'bun' -> absolute path in MCP + hooks -------------------
  rewrite_bun "$PLUGIN_DIR/.mcp.json"
  rewrite_bun "$PLUGIN_DIR/hooks/hooks.json"
  say "rewrote bun command to absolute path in .mcp.json + hooks.json"

  # --- 4. register marketplace + enable plugin --------------------------------
  if [ -n "$CLAUDE_BIN" ]; then
    say "registering marketplace + installing plugin"
    "$CLAUDE_BIN" plugin marketplace add "$MARKETPLACE_DIR" >/dev/null 2>&1 || true
    "$CLAUDE_BIN" plugin install "${PLUGIN_NAME}@${MARKETPLACE_NAME}" >/dev/null 2>&1 \
      || say "note: could not auto-install; run: claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
  else
    say "note: 'claude' CLI not on PATH — install manually with:"
    say "  claude plugin marketplace add $MARKETPLACE_DIR"
    say "  claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
  fi

  # --- 5/6. wrap-chain statusLine + pre-allow the reply tool in settings.json --
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
    const MARK = "# imsg-device statusline";
    const prev = s.statusLine;
    let prefix = "";
    if (prev && typeof prev === "object" && typeof prev.command === "string") {
      const c = prev.command;
      if (c.includes(MARK)) {
        const idx = c.indexOf("; " + ours);
        prefix = idx >= 0 ? c.slice(0, idx) : "";
      } else {
        prefix = c;
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

  # --- 7. pair (shared) -------------------------------------------------------
  pair_device "${PLUGIN_DIR}/bin/imsg.ts"

  # --- 8. alias `claude` to load the imsg-device channel ----------------------
  # The AFK permission relay only activates with --dangerously-load-development-
  # channels (CC-only; NOT used for Codex). Marker-wrapped + revertable.
  CHANNEL_REF="plugin:${PLUGIN_NAME}@${MARKETPLACE_NAME}"
  CLAUDE_ALIAS="alias claude='claude --dangerously-load-development-channels ${CHANNEL_REF}'"
  RC_BLOCK_ID="imsg-device channels alias"

  write_rc_block() {
    rc="$1"
    RC_FILE="$rc" BLOCK_ID="$RC_BLOCK_ID" ALIAS_LINE="$CLAUDE_ALIAS" "$BUN" -e '
      const fs = require("fs");
      const f = process.env.RC_FILE, id = process.env.BLOCK_ID, alias = process.env.ALIAS_LINE;
      const begin = `# >>> ${id} >>>`, end = `# <<< ${id} <<<`;
      let s = ""; try { s = fs.readFileSync(f, "utf8"); } catch {}
      const bi = s.indexOf(begin);
      if (bi !== -1) { const ei = s.indexOf(end, bi); if (ei !== -1) s = s.slice(0, bi) + s.slice(ei + end.length); }
      s = s.replace(/\n{3,}/g, "\n\n");
      if (s.length && !s.endsWith("\n")) s += "\n";
      s += `${begin}\n${alias}\n${end}\n`;
      fs.writeFileSync(f, s);
    '
  }

  ALIASED=""
  for RC in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [ "$RC" = "$HOME/.zshrc" ] || [ -f "$RC" ]; then
      [ -f "$RC" ] || : > "$RC"
      write_rc_block "$RC"
      ALIASED="$ALIASED $RC"
    fi
  done
  say "aliased 'claude' to load the channel (--dangerously-load-development-channels ${CHANNEL_REF}) in:${ALIASED}"
  say "  open a NEW terminal (or run: source ~/.zshrc) for it to take effect"
  say "done (Claude Code). Open a NEW terminal so the alias loads, then start Claude Code."
}

# =============================================================================
# Codex target — additive; mirrors prbe-codex-tap-plugin's install shape.
#
# Codex differs from Claude Code in five ways, all handled below:
#   1. Manifest:  .codex-plugin/plugin.json (declares mcpServers: ./.mcp.codex.json).
#   2. Hooks:     Codex loads hooks/hooks.json by convention — so we install the
#                 Codex hooks (hooks/codex/hooks.json) AS hooks/hooks.json in the
#                 Codex plugin dir, and drop the CC hooks. plugin_hooks must be on.
#   3. MCP:       registered by the plugin manifest's mcpServers pointer (the
#                 .mcp.codex.json, command=bun + IMSG_AGENT_KIND=codex). We do NOT
#                 also write [mcp_servers.imsg-device] into config.toml — the
#                 plugin-declared server is the single source of truth (mirrors
#                 the cloudflare plugin). [FLAG: if a future Codex drops manifest
#                 mcpServers support, fall back to the config.toml merge — see the
#                 commented block in this function.]
#   4. Register:  `codex plugin marketplace add <local-dir>` writes [marketplaces.*];
#                 enabling the plugin + plugin_hooks is written into config.toml
#                 non-destructively (no `codex plugin install` CLI exists).
#   5. NO channels alias, NO statusLine, NO --dangerously-load-development-channels
#                 (all CC-only). NO SessionEnd hook (Codex has none; the tap daemon
#                 self-exits via its lsof orphan check).
#
# [LIVE-VERIFY] Every Codex registration step below needs a real `codex` run to
# confirm — the plugin loads, hooks fire (after the hash-trust step), and the MCP
# server appears. Flagged inline.
# =============================================================================
CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"
CODEX_CONFIG="${CODEX_HOME}/config.toml"
CODEX_MARKETPLACE_DIR="${CODEX_HOME}/marketplaces/${MARKETPLACE_NAME}-local"
CODEX_PLUGIN_DIR="${CODEX_MARKETPLACE_DIR}/${PLUGIN_NAME}"

install_for_codex() {
  # Self-skip when the Codex CLI is absent. With DEFAULT=both, a Claude-Code-only
  # machine must NOT get ~/.codex config/plugin artifacts it can't use; and an
  # explicit IMSG_AGENT_TARGET=codex on a codex-less machine should say so plainly
  # rather than stage a plugin nothing will load.
  if ! command -v codex >/dev/null 2>&1; then
    say "codex CLI not found on PATH — skipping Codex install. Install codex, then re-run with IMSG_AGENT_TARGET=codex."
    return 0
  fi
  CODEX_BIN="$(command -v codex || true)"

  # --- stage the Codex plugin into a local marketplace ------------------------
  #   $CODEX_MARKETPLACE_DIR/.claude-plugin/marketplace.json  (catalog; source ./imsg-device)
  #   $CODEX_MARKETPLACE_DIR/imsg-device/<the plugin>          (staged here)
  say "staging Codex plugin into $CODEX_PLUGIN_DIR"
  rm -rf "$CODEX_PLUGIN_DIR"
  mkdir -p "$CODEX_PLUGIN_DIR" "$CODEX_MARKETPLACE_DIR/.claude-plugin" "$DEVICE_DIR"
  ( cd "$SRC" && tar --exclude=node_modules --exclude=logs --exclude='.token' -cf - . ) \
    | ( cd "$CODEX_PLUGIN_DIR" && tar -xf - )

  # Codex loads hooks from hooks/hooks.json — install the Codex hooks there and
  # drop the CC hooks so Codex never loads the AskUserQuestion/ExitPlanMode set.
  [ -f "$CODEX_PLUGIN_DIR/hooks/codex/hooks.json" ] \
    || die "no hooks/codex/hooks.json in the staged tree — bad Codex plugin package"
  mv -f "$CODEX_PLUGIN_DIR/hooks/codex/hooks.json" "$CODEX_PLUGIN_DIR/hooks/hooks.json"
  # IMPORTANT: do NOT remove hooks/codex/ — the just-moved hooks/hooks.json still
  # points at ${CLAUDE_PLUGIN_ROOT}/hooks/codex/{session-start,user-prompt-submit,
  # permission-request,stop}.ts. Those .ts scripts must stay where the JSON resolves
  # them; deleting the dir would make every Codex hook fail to launch (and a failed
  # PermissionRequest hook fails OPEN to the unattended local prompt — a safety
  # regression). Only the now-duplicate hooks/codex/hooks.json (moved up) is removed.
  rm -f "$CODEX_PLUGIN_DIR/hooks/codex/hooks.json"
  # Codex commands: install the prompt-style /afk under commands/ (CC's exec-style
  # afk.md would be a no-op prompt under Codex), then drop the codex/ staging dir
  # (its only file, afk.md, has been moved up — nothing else references it).
  if [ -f "$CODEX_PLUGIN_DIR/commands/codex/afk.md" ]; then
    mv -f "$CODEX_PLUGIN_DIR/commands/codex/afk.md" "$CODEX_PLUGIN_DIR/commands/afk.md"
  fi
  rm -rf "$CODEX_PLUGIN_DIR/commands/codex"

  # Build the root catalog from the Codex marketplace.json (source "." -> subdir),
  # then drop the inner per-plugin manifests CC-style (root catalog authoritative).
  INNER_MKT_CDX="$CODEX_PLUGIN_DIR/.codex-plugin/marketplace.json"
  [ -f "$INNER_MKT_CDX" ] || die "no .codex-plugin/marketplace.json in the staged tree — bad Codex plugin package"
  PLUGIN_SUBDIR="$PLUGIN_NAME" "$BUN" -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const sub = "./" + process.env.PLUGIN_SUBDIR;
    for (const p of (m.plugins || [])) {
      if (p && (p.source === undefined || p.source === "." || p.source === "./")) p.source = sub;
    }
    fs.writeFileSync(process.argv[2], JSON.stringify(m, null, 2) + "\n");
  ' "$INNER_MKT_CDX" "$CODEX_MARKETPLACE_DIR/.claude-plugin/marketplace.json"
  rm -f "$INNER_MKT_CDX"
  # The Codex plugin never loads the CC marketplace.json; drop it so the Codex
  # loader doesn't see two catalogs in the plugin subdir.
  rm -f "$CODEX_PLUGIN_DIR/.claude-plugin/marketplace.json"

  vendor_shared "$CODEX_PLUGIN_DIR"
  bake_build_config "$CODEX_PLUGIN_DIR"
  say "installing Codex plugin dependencies with bun"
  ( cd "$CODEX_PLUGIN_DIR" && "$BUN" install --production ) || die "bun install failed (codex)"

  # Absolute-path the bun interpreter in the Codex hooks + MCP file.
  rewrite_bun "$CODEX_PLUGIN_DIR/hooks/hooks.json"
  rewrite_bun "$CODEX_PLUGIN_DIR/.mcp.codex.json"
  say "rewrote bun command to absolute path in Codex hooks.json + .mcp.codex.json"

  # --- register the marketplace (writes [marketplaces.*] into config.toml) ----
  # [LIVE-VERIFY] `codex plugin marketplace add <local-dir>` — confirm it reads
  # our marketplace.json name ($MARKETPLACE_NAME) so the plugin ref resolves to
  # imsg-device@$MARKETPLACE_NAME.
  if [ -n "$CODEX_BIN" ]; then
    "$CODEX_BIN" plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
    if "$CODEX_BIN" plugin marketplace add "$CODEX_MARKETPLACE_DIR" >/dev/null 2>&1; then
      say "registered Codex marketplace from $CODEX_MARKETPLACE_DIR"
    else
      say "note: 'codex plugin marketplace add' failed — run manually:"
      say "  codex plugin marketplace add $CODEX_MARKETPLACE_DIR"
    fi
  else
    say "note: register the Codex marketplace manually with:"
    say "  codex plugin marketplace add $CODEX_MARKETPLACE_DIR"
  fi

  # --- enable the plugin + plugin_hooks in config.toml (non-destructive) ------
  # There is NO `codex plugin install` CLI (only marketplace mgmt), so we write
  # the enable + feature flags directly into config.toml WITHOUT clobbering the
  # user's existing mcp_servers / plugins / marketplaces. Idempotent: a present
  # block is left as-is; a missing one is appended.
  CODEX_CONFIG="$CODEX_CONFIG" PLUGIN_REF="${PLUGIN_NAME}@${MARKETPLACE_NAME}" "$BUN" -e '
    const fs = require("fs");
    const f = process.env.CODEX_CONFIG;
    const ref = process.env.PLUGIN_REF;
    let s = ""; try { s = fs.readFileSync(f, "utf8"); } catch {}
    // [plugins."imsg-device@imsg"] enabled = true — append if no such table.
    const pluginHeader = `[plugins."${ref}"]`;
    if (s.indexOf(pluginHeader) === -1) {
      if (s.length && !s.endsWith("\n")) s += "\n";
      s += `\n${pluginHeader}\nenabled = true\n`;
    }
    // [features] plugin_hooks = true — ensure the table + the key (non-destructive).
    // Match a real `plugin_hooks =` key assignment, not any substring mention: a
    // bare indexOf would treat a comment or unrelated reference as "already set"
    // and silently skip writing the key, disabling Codex hooks. Mirrors the precise
    // regex the uninstall path uses (/^\s*plugin_hooks\s*=\s*true\s*$\n?/m).
    if (!/^\s*plugin_hooks\s*=/m.test(s)) {
      const fi = s.indexOf("[features]");
      if (fi === -1) {
        if (s.length && !s.endsWith("\n")) s += "\n";
        s += "\n[features]\nplugin_hooks = true\n";
      } else {
        // Insert the key right after the [features] header line.
        const nl = s.indexOf("\n", fi);
        const at = nl === -1 ? s.length : nl + 1;
        s = s.slice(0, at) + "plugin_hooks = true\n" + s.slice(at);
      }
    }
    fs.mkdirSync(require("path").dirname(f), { recursive: true });
    fs.writeFileSync(f, s);
  '
  say "enabled ${PLUGIN_NAME}@${MARKETPLACE_NAME} + [features] plugin_hooks=true in $CODEX_CONFIG (non-destructive merge)"

  # --- MCP server registration ------------------------------------------------
  # The plugin manifest's "mcpServers": "./.mcp.codex.json" registers the MCP
  # server when Codex loads the plugin (command=bun, env IMSG_AGENT_KIND=codex) —
  # the single source of truth, mirroring the cloudflare plugin. We deliberately
  # do NOT also write [mcp_servers.imsg-device] into config.toml (that would be a
  # second, drift-prone registration).
  #
  # [FALLBACK / FLAG] If a live `codex` run shows the manifest mcpServers pointer
  # is NOT honored in this Codex version, register it in config.toml instead with
  # a non-destructive merge like the plugins block above, e.g.:
  #   [mcp_servers.imsg-device]
  #   command = "<abs bun>"
  #   args = ["run", "--cwd", "<CODEX_PLUGIN_DIR>", "--silent", "start"]
  #   [mcp_servers.imsg-device.env]
  #   IMSG_AGENT_KIND = "codex"
  say "MCP server registered via plugin manifest mcpServers (.mcp.codex.json) [LIVE-VERIFY]"

  # --- pair (shared) ----------------------------------------------------------
  pair_device "${CODEX_PLUGIN_DIR}/bin/imsg.ts"

  # --- hook hash-trust --------------------------------------------------------
  # Codex hash-trusts plugin hooks before running them (a security gate). The
  # first `codex` session after install will prompt to trust the imsg-device
  # hooks; accept once via the /hooks UI. [LIVE-VERIFY: confirm the exact trust
  # affordance in this Codex version — it may be a /hooks command or a startup
  # prompt; there is no documented non-interactive bypass flag we rely on here.]
  say "ACTION REQUIRED: start Codex once and TRUST the imsg-device hooks (the /hooks"
  say "  trust step) — Codex hash-trusts plugin hooks before it will run them."
  say "done (Codex). The plugin + MCP load on your next Codex session after trusting hooks."
}

# =============================================================================
# Dispatch by target.
# =============================================================================
case "$IMSG_AGENT_TARGET" in
  claude-code) install_for_claude_code ;;
  codex)       install_for_codex ;;
  both)        install_for_claude_code; install_for_codex ;;
esac

if [ -n "${IMSG_INSTALL_BASE:-}" ]; then
  say "revert anytime:  curl -fsSL ${IMSG_INSTALL_BASE%/}/uninstall.sh | IMSG_AGENT_TARGET=${IMSG_AGENT_TARGET} sh"
else
  say "revert anytime:  IMSG_AGENT_TARGET=${IMSG_AGENT_TARGET} run uninstall.sh from this plugin"
fi
