/**
 * Single-use token minting + hashing.
 *
 * Two token families share this primitive:
 *   - onboarding tokens — texted in by the user during onboarding so we can
 *     match the inbound message back to their account and derive their phone
 *     number. Session-bound (`sso_session_id`) and rate-limited (`attempts`).
 *   - pairing tokens — embedded in the install.sh one-liner, exchanged once
 *     at the control plane's /api/device/pair for a long-lived device_token.
 *
 * The raw token is shown to the user exactly once (deep link / install
 * command); only its peppered hash is persisted. >=128 bits of entropy.
 *
 * HASHING CONTRACT (load-bearing across lanes): `hashToken` is a peppered
 * HMAC-SHA256 keyed by DEVICE_TOKEN_PEPPER — the EXACT same construction the
 * control plane uses (apps/control-plane/src/auth/device.ts `hashToken`). The
 * dashboard stores `pairing_tokens.token_hash`; the device sends the raw token
 * to the control plane's /api/device/pair, which re-derives the same peppered
 * hash to look the row up. A plain (un-peppered) hash, or a different pepper,
 * silently breaks pairing — the lookup never matches. They MUST stay in lockstep.
 *
 * Server-only — uses node:crypto + the server-side pepper.
 */

import "server-only";

import { randomBytes, createHmac } from "node:crypto";

import { ENV } from "@/lib/idp/env";

/** Raw token length in bytes. 24 bytes -> 192 bits, well over the 128-bit floor. */
const TOKEN_BYTES = 24;

/** Onboarding token TTL: short — the user texts it within seconds. */
export const ONBOARDING_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Pairing token TTL: short — the user runs install.sh promptly. */
export const PAIRING_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Max inbound match attempts before an onboarding token is burned. */
export const MAX_ONBOARDING_ATTEMPTS = 10;

/** Mint a fresh URL-safe raw token (base64url, no padding). */
export function mintRawToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Peppered hash of a raw token for storage / lookup. Deterministic (the pepper
 *  is a fixed server-side secret, not a per-token salt) so the control plane can
 *  re-derive the identical hash from the raw token and look the row up by PK.
 *  Keep in lockstep with apps/control-plane/src/auth/device.ts `hashToken`. */
export function hashToken(raw: string): string {
  return createHmac("sha256", ENV.deviceTokenPepper())
    .update(raw, "utf8")
    .digest("hex");
}

/** An expiry timestamp `ms` in the future, as an ISO string for Postgres. */
export function expiryFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}
