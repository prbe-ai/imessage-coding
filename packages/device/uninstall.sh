#!/usr/bin/env bash
# =============================================================================
# imsg-device uninstaller — reverts everything install.sh did.
#
#   curl -fsSL https://msg.example.com/uninstall.sh | sh
#
# In order:
#   1. Remove the `claude` channels alias block from ~/.zshrc + ~/.bashrc.
#   2. Uninstall the plugin + remove the local marketplace (claude CLI).
#   3. Restore ~/.claude/settings.json from the install's backup (undoes the
#      wrap-chained statusLine + the pre-allowed reply permission).
#   4. Remove the staged plugin code + the local device state (token, outbox).
#
# All steps are best-effort + idempotent — safe to run more than once, and safe
# even if the install was partial. POSIX sh compatible (documented `| sh`).
# =============================================================================
set -eu

PLUGIN_NAME="imsg-device"
MARKETPLACE_NAME="imsg"
# Which target to uninstall. Mirrors install.sh; default claude-code so a bare
# uninstall one-liner is unchanged. claude-code | codex | both.
IMSG_AGENT_TARGET="${IMSG_AGENT_TARGET:-claude-code}"
CLAUDE_DIR="${HOME}/.claude"
SETTINGS="${CLAUDE_DIR}/settings.json"
BACKUP="${SETTINGS}.imsg-backup"
DEVICE_DIR="${IMSG_DEVICE_DIR:-${HOME}/.imsg}"
# Pre-0.1.7 state lived nested under Claude Code's plugin dir; sweep it too.
LEGACY_DEVICE_DIR="${CLAUDE_DIR}/plugins/${PLUGIN_NAME}"
MARKETPLACE_DIR="${CLAUDE_DIR}/plugins/marketplaces/${MARKETPLACE_NAME}"
RC_BLOCK_ID="imsg-device channels alias"
# Codex locations (mirror install.sh).
CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"
CODEX_CONFIG="${CODEX_HOME}/config.toml"
CODEX_MARKETPLACE_DIR="${CODEX_HOME}/marketplaces/${MARKETPLACE_NAME}-local"

say() { printf '[imsg-uninstall] %s\n' "$*"; }

BUN="$(command -v bun || true)"

case "$IMSG_AGENT_TARGET" in
  claude-code|codex|both) : ;;
  *) say "note: unknown IMSG_AGENT_TARGET '$IMSG_AGENT_TARGET' — treating as claude-code"; IMSG_AGENT_TARGET="claude-code" ;;
esac

# --- Claude Code uninstall --------------------------------------------------
uninstall_claude_code() {
  # 1. strip the claude alias block from shell rc files
  strip_rc_block() {
    rc="$1"
    [ -f "$rc" ] || return 0
    if [ -z "$BUN" ]; then
      say "note: bun not on PATH — remove the '$RC_BLOCK_ID' block from $rc by hand"
      return 0
    fi
    RC_FILE="$rc" BLOCK_ID="$RC_BLOCK_ID" "$BUN" -e '
      const fs = require("fs");
      const f = process.env.RC_FILE, id = process.env.BLOCK_ID;
      const begin = `# >>> ${id} >>>`, end = `# <<< ${id} <<<`;
      let s = ""; try { s = fs.readFileSync(f, "utf8"); } catch { process.exit(0); }
      const bi = s.indexOf(begin);
      if (bi !== -1) {
        const ei = s.indexOf(end, bi);
        if (ei !== -1) { s = s.slice(0, bi) + s.slice(ei + end.length); fs.writeFileSync(f, s.replace(/\n{3,}/g, "\n\n")); }
      }
    '
  }
  for RC in "$HOME/.zshrc" "$HOME/.bashrc"; do strip_rc_block "$RC"; done
  say "removed the 'claude' channels alias (open a new terminal for it to take effect)"

  # 2. unregister the plugin + marketplace (`marketplace remove` deletes the dir).
  CLAUDE_BIN="$(command -v claude || true)"
  if [ -n "$CLAUDE_BIN" ]; then
    "$CLAUDE_BIN" plugin uninstall "${PLUGIN_NAME}@${MARKETPLACE_NAME}" >/dev/null 2>&1 || true
    "$CLAUDE_BIN" plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
    say "unregistered ${PLUGIN_NAME}@${MARKETPLACE_NAME} (Claude Code)"
  else
    say "note: 'claude' CLI not on PATH — disable manually: claude plugin uninstall ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
  fi

  # 3. restore settings.json from the install backup (undoes statusLine + reply perm).
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$SETTINGS" && rm -f "$BACKUP"
    say "restored settings.json from backup"
  else
    say "note: no settings backup found — leaving settings.json as-is"
  fi

  rm -rf "$MARKETPLACE_DIR"
  say "removed Claude Code plugin files"
}

# --- Codex uninstall --------------------------------------------------------
uninstall_codex() {
  # 1. uninstall the plugin (clears the ~/.codex/plugins/cache snapshot + the
  #    config enable block), THEN remove the marketplace registration. `codex
  #    plugin remove` is the counterpart to the install's `codex plugin add`;
  #    `marketplace remove` then drops the [marketplaces.*] source.
  CODEX_BIN="$(command -v codex || true)"
  if [ -n "$CODEX_BIN" ]; then
    "$CODEX_BIN" plugin remove "${PLUGIN_NAME}@${MARKETPLACE_NAME}" >/dev/null 2>&1 || true
    "$CODEX_BIN" plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
    say "uninstalled ${PLUGIN_NAME}@${MARKETPLACE_NAME} + unregistered Codex marketplace ${MARKETPLACE_NAME}"
  else
    say "note: 'codex' CLI not on PATH — remove manually: codex plugin remove ${PLUGIN_NAME}@${MARKETPLACE_NAME} && codex plugin marketplace remove ${MARKETPLACE_NAME}"
  fi

  # 2. strip OUR blocks from config.toml non-destructively (the [plugins."ref"]
  #    enable table + the plugin_hooks key + any [marketplaces.*-local] table we
  #    added). Leaves the user's other mcp_servers / plugins / marketplaces intact.
  if [ -n "$BUN" ]; then
    CODEX_CONFIG="$CODEX_CONFIG" PLUGIN_REF="${PLUGIN_NAME}@${MARKETPLACE_NAME}" MKT="${MARKETPLACE_NAME}-local" "$BUN" -e '
      const fs = require("fs");
      const f = process.env.CODEX_CONFIG;
      const ref = process.env.PLUGIN_REF;
      let s = ""; try { s = fs.readFileSync(f, "utf8"); } catch { process.exit(0); }
      // Drop a whole TOML table by its header line, up to the next [header] or EOF.
      const dropTable = (text, header) => {
        const i = text.indexOf(header);
        if (i === -1) return text;
        const after = text.indexOf("\n[", i + header.length);
        const end = after === -1 ? text.length : after + 1;
        return text.slice(0, i) + text.slice(end);
      };
      s = dropTable(s, `[plugins."${ref}"]`);
      // Remove our plugin_hooks key (leave the [features] table for other flags).
      s = s.replace(/^\s*plugin_hooks\s*=\s*true\s*$\n?/m, "");
      // If [features] is now an empty table, drop it.
      s = s.replace(/\[features\]\s*\n(?=\s*(\[|$))/m, "");
      s = s.replace(/\n{3,}/g, "\n\n");
      fs.writeFileSync(f, s);
    ' || say "note: could not edit $CODEX_CONFIG — remove the [plugins.\"${PLUGIN_NAME}@${MARKETPLACE_NAME}\"] block + plugin_hooks by hand"
    say "removed Codex plugin enable + plugin_hooks from $CODEX_CONFIG (non-destructive)"
  else
    say "note: bun not on PATH — remove the Codex plugin block from $CODEX_CONFIG by hand"
  fi

  # 3. remove the LEGACY /afk custom prompt left by older installers (the Codex
  #    prompts mechanism was dropped in favor of the skill at skills/afk/SKILL.md,
  #    which lives in the plugin tree and is removed with it). Marker-guarded so a
  #    user's own ~/.codex/prompts/afk.md is never clobbered.
  CODEX_AFK_PROMPT="${CODEX_HOME}/prompts/afk.md"
  if [ -f "$CODEX_AFK_PROMPT" ] && grep -q 'imsg-device:managed' "$CODEX_AFK_PROMPT"; then
    rm -f "$CODEX_AFK_PROMPT"
    say "removed Codex /afk custom prompt ($CODEX_AFK_PROMPT)"
  fi

  # 4. remove the staged Codex plugin tree + the (now-empty) install cache.
  rm -rf "$CODEX_MARKETPLACE_DIR" "${CODEX_HOME}/plugins/cache/${MARKETPLACE_NAME}"
  say "removed Codex plugin files"
}

case "$IMSG_AGENT_TARGET" in
  claude-code) uninstall_claude_code ;;
  codex)       uninstall_codex ;;
  both)        uninstall_claude_code; uninstall_codex ;;
esac

# --- shared: remove local device state (token, outbox) ----------------------
# Both agents share ONE ~/.imsg device dir; remove it last (it is the token +
# outbox + afk state, common to both targets).
rm -rf "$DEVICE_DIR" "$LEGACY_DEVICE_DIR"
say "removed local device state (token, outbox, afk)"

say "done. Restart the affected agent(s). Re-install anytime from the dashboard."
