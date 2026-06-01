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
CLAUDE_DIR="${HOME}/.claude"
SETTINGS="${CLAUDE_DIR}/settings.json"
BACKUP="${SETTINGS}.imsg-backup"
DEVICE_DIR="${IMSG_DEVICE_DIR:-${CLAUDE_DIR}/plugins/${PLUGIN_NAME}}"
MARKETPLACE_DIR="${CLAUDE_DIR}/plugins/marketplaces/${MARKETPLACE_NAME}"
RC_BLOCK_ID="imsg-device channels alias"

say() { printf '[imsg-uninstall] %s\n' "$*"; }

BUN="$(command -v bun || true)"

# --- 1. strip the claude alias block from shell rc files --------------------
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

# --- 2. unregister the plugin + marketplace ---------------------------------
# `marketplace remove` also deletes the marketplace's install dir.
CLAUDE_BIN="$(command -v claude || true)"
if [ -n "$CLAUDE_BIN" ]; then
  "$CLAUDE_BIN" plugin uninstall "${PLUGIN_NAME}@${MARKETPLACE_NAME}" >/dev/null 2>&1 || true
  "$CLAUDE_BIN" plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
  say "unregistered ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
else
  say "note: 'claude' CLI not on PATH — disable manually with: claude plugin uninstall ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
fi

# --- 3. restore settings.json from the install backup -----------------------
# install.sh backs up the PRE-install settings once; restoring it undoes the
# statusLine wrap-chain + the reply permission. (Settings changes you made after
# installing are not preserved — that's the documented restore-from-backup path.)
if [ -f "$BACKUP" ]; then
  cp "$BACKUP" "$SETTINGS" && rm -f "$BACKUP"
  say "restored settings.json from backup"
else
  say "note: no settings backup found — leaving settings.json as-is"
fi

# --- 4. remove staged code + local device state ----------------------------
rm -rf "$MARKETPLACE_DIR" "$DEVICE_DIR"
say "removed plugin files + local device state (token, outbox)"

say "done. Restart Claude Code. Re-install anytime from the dashboard."
