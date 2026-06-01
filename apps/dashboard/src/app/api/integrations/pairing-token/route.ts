/**
 * POST /api/integrations/pairing-token
 *
 * Mints a single-use, short-TTL pairing token for the current account and
 * returns the one-line install command that embeds it. The device's
 * install.sh exchanges the token at the control plane's POST /api/device/pair
 * for a long-lived device_token (the token is burned on first use).
 *
 * Only the token hash is persisted (`pairing_tokens`); the raw token rides in
 * the install command shown once on the Integrations page. Each mint
 * supersedes the account's prior un-used pairing tokens.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { query } from "@/lib/db";
import {
  mintRawToken,
  hashToken,
  expiryFromNow,
  PAIRING_TOKEN_TTL_MS,
} from "@/lib/tokens";
import type { PairingTokenResponse } from "@/lib/api/contracts";

export const dynamic = "force-dynamic";

/** Public origin that serves the install script at `/install.sh`.
 *
 *  This is the dashboard's own public web origin (`NEXT_PUBLIC_APP_URL`,
 *  e.g. https://msg.example.com) — NOT the control plane (`CONTROL_PLANE_URL`,
 *  the Fly API host), which does not serve static assets. The build copies
 *  packages/device/install.sh into public/install.sh so this origin serves it.
 *  Falls back to the dashboard's local-dev origin. Server-side only. */
function installBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000"
  ).replace(/\/+$/, "");
}

export async function POST(req: Request): Promise<Response> {
  const ctx = await requireAccount(req);
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Burn prior un-used pairing tokens for this account so only the newest
  // install command works (single-use, last-write-wins).
  await query(
    `UPDATE pairing_tokens SET used_at = now()
      WHERE account_id = $1 AND used_at IS NULL`,
    [ctx.accountId],
  );

  const raw = mintRawToken();
  const expiresAt = expiryFromNow(PAIRING_TOKEN_TTL_MS);
  await query(
    `INSERT INTO pairing_tokens (token_hash, account_id, expires_at)
     VALUES ($1, $2, $3)`,
    [hashToken(raw), ctx.accountId, expiresAt],
  );

  // Canonical one-liner. The served install.sh bakes its own origin
  // (IMSG_INSTALL_BASE) at build time, and the control-plane URL is baked into
  // the plugin tarball (build-config.json), so neither needs to ride in the
  // command — just the pairing token.
  const base = installBaseUrl();
  const installCommand = `curl -fsSL ${base}/install.sh | TOKEN=${raw} sh`;

  const body: PairingTokenResponse = { token: raw, expiresAt, installCommand };
  return NextResponse.json(body, { status: 200 });
}
