/**
 * Browser-side Better Auth client. Import this from "use client" components
 * to call `signIn.social(...)` / `signOut()` / `useSession()` without
 * re-implementing the wire protocol.
 *
 * Sign-in is Google-only (`signIn.social({ provider: "google" })`); there is
 * no signUp / password-reset surface, so those aren't re-exported.
 */

"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  // HTTP surface is mounted at /api/idp (see src/lib/idp/auth.ts basePath).
  // Same-origin: Better Auth's client picks up window.location.origin.
  basePath: "/api/idp",
});

export const { signIn, signOut, useSession } = authClient;
