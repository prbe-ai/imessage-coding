/**
 * Better Auth CLI entry point.
 *
 * `@better-auth/cli` (generate / migrate) needs an exported `auth` instance
 * to discover the schema. The app itself uses `getAuth()` (lazy — see
 * ./auth.ts) so `next build` doesn't require DATABASE_URL at build time. This
 * module exists ONLY for the CLI: it eagerly constructs the instance, so
 * DATABASE_URL / BETTER_AUTH_SECRET / BETTER_AUTH_URL / GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET must be set when you run the CLI.
 *
 *   DATABASE_URL=postgresql://…/imessage_coding \
 *   BETTER_AUTH_SECRET=… BETTER_AUTH_URL=https://msg.example.com \
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
 *   bunx @better-auth/cli@latest migrate --config src/lib/idp/auth-cli.ts
 *
 * Nothing in the Next.js app imports this file, so it never affects the build.
 */

// Relative import (not the `@/` alias) so the Better Auth CLI's loader can
// resolve it without depending on tsconfig path mapping.
import { getAuth } from "./auth";

export const auth = getAuth();
