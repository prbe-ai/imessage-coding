/**
 * Centralized env reader. Throws clearly on missing required vars at
 * server-side first use rather than letting `undefined` propagate into JWT
 * signing or DB connection paths where the failure would be opaque.
 *
 * Server-only — it reads secrets.
 */

import "server-only";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(
      `Missing required env var: ${name}. See .env.example for setup.`,
    );
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export const ENV = {
  databaseUrl: () => required("DATABASE_URL"),
  betterAuthSecret: () => required("BETTER_AUTH_SECRET"),
  betterAuthUrl: () => required("BETTER_AUTH_URL"),

  // Google OAuth client for "Continue with Google" — a client in our own GCP
  // project (redirect URI `${BETTER_AUTH_URL}/api/idp/callback/google`).
  // Required when the auth surface runs; `getAuth()` is lazy, so an unset
  // value surfaces on first auth use, never at `next build`.
  googleClientId: () => required("GOOGLE_CLIENT_ID"),
  googleClientSecret: () => required("GOOGLE_CLIENT_SECRET"),

  // Control plane base URL. The dashboard proxies live session reads, AFK
  // toggles, and pairing-token minting to the control plane. Server-side only.
  controlPlaneUrl: () => optional("CONTROL_PLANE_URL", "http://localhost:8080"),

  // Server-side pepper mixed into pairing/onboarding token hashing. MUST be the
  // SAME value the control plane reads (its DEVICE_TOKEN_PEPPER): the dashboard
  // stores only the peppered hash, and the control plane re-derives the same
  // peppered hash from the raw token at /api/device/pair to look the row up. A
  // mismatch (or a plain, un-peppered hash on either side) silently breaks
  // pairing — the lookup never matches.
  deviceTokenPepper: () => required("DEVICE_TOKEN_PEPPER"),
};
