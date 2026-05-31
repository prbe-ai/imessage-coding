/**
 * Better Auth configuration (self-hosted, Google-only).
 *
 * This dashboard is THE identity provider for the iMessage-coding product. It
 * hosts a self-hosted Better Auth instance backed by the same Neon database
 * the control plane uses. Better Auth owns its own `better_auth_*` tables
 * (created/migrated via the Better Auth CLI — see ./auth-cli.ts); the
 * product's own `accounts` table mirrors the authenticated user's email.
 *
 * LAZY INITIALIZATION:
 *   `betterAuth(...)` and the `pg.Pool` are constructed on first call to
 *   `getAuth()`, not at module scope. This keeps `next build` working even
 *   when DATABASE_URL / BETTER_AUTH_SECRET / BETTER_AUTH_URL are unset (they
 *   are runtime-only). Importing this module is side-effect free.
 *
 * SIGN-IN: Google-only. There is no email/password surface — `emailAndPassword`
 *   is left unset, which Better Auth treats as disabled. The HTTP surface is
 *   mounted at `/api/idp` (see ./auth-cli.ts + src/app/api/idp/[...all]/route.ts).
 */

import "server-only";

import { betterAuth } from "better-auth";
import { Pool } from "pg";

import { ENV } from "@/lib/idp/env";

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: ENV.databaseUrl() });
  }
  return pool;
}

function createAuth() {
  return betterAuth({
    database: getPool(),
    secret: ENV.betterAuthSecret(),
    baseURL: ENV.betterAuthUrl(),
    basePath: "/api/idp",

    socialProviders: {
      google: {
        clientId: ENV.googleClientId(),
        clientSecret: ENV.googleClientSecret(),
      },
    },

    advanced: {
      useSecureCookies: process.env.NODE_ENV === "production",
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

let authInstance: Auth | undefined;

/** Construct (and memoize) the Better Auth instance. */
export function getAuth(): Auth {
  if (!authInstance) {
    authInstance = createAuth();
  }
  return authInstance;
}
