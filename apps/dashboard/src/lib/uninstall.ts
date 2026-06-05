/**
 * The uninstall one-liner. Unlike install, it carries no pairing token — it's
 * all-local (strip the relay alias, restore settings, unregister the plugin,
 * drop the device token), so it's a constant for this deployment and can render
 * immediately, independent of minting. The dashboard's own public origin serves
 * `/uninstall.sh` (see scripts/copy-install-script.mjs); the base mirrors the
 * server's installBaseUrl() fallback so install + uninstall always agree.
 * `IMSG_AGENT_TARGET=both` matches the install default (install.sh defaults to
 * `both`), so this reverts Claude Code and Codex together — Codex self-skips if
 * it isn't present.
 *
 * Shared between the Integrations page and the delete-account modal so both show
 * the exact same command.
 */
export const UNINSTALL_COMMAND = `curl -fsSL ${(
  process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
).replace(/\/+$/, "")}/uninstall.sh | IMSG_AGENT_TARGET=both sh`;
