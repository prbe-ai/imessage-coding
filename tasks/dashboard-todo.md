# apps/dashboard — build plan

Mirror prbe-dashboard stack + DESIGN.md. Next 16 app-router, Better Auth
(Google-only) at /api/idp, pg->Neon, `imsg_session` cookie, Tailwind v4 +
shadcn (new-york, light-only, warm-neutral). Import contracts from @imsg/shared.

## Config / scaffolding
- [x] package.json (@imsg/dashboard) — Next 16.1.6, React 19.2.3, better-auth, pg, tailwind v4, shadcn deps
- [x] tsconfig.json (extends nothing — Next needs its own; @/* alias), next.config.ts (standalone), postcss, eslint, next-env.d.ts
- [x] components.json (new-york, neutral)
- [x] src/app/globals.css (warm-neutral tokens + onboarding palette + signin/onboarding/home/integrations CSS)

## lib
- [x] src/lib/utils.ts (cn, formatRelativeTime)
- [x] src/lib/idp/env.ts (DATABASE_URL, BETTER_AUTH_SECRET/URL, GOOGLE_*, CONTROL_PLANE_URL)
- [x] src/lib/idp/auth.ts (lazy betterAuth, Google-only, basePath /api/idp, pg Pool)
- [x] src/lib/idp/auth-cli.ts (CLI entry)
- [x] src/lib/idp/better-auth-client.ts (client signIn/signOut/useSession)
- [x] src/lib/idp/session-cookie.ts (IMSG_SESSION_COOKIE_NAME)
- [x] src/lib/db.ts (shared pg Pool for app data: accounts/tokens/sessions)
- [x] src/lib/tokens.ts (mint/hash single-use tokens — onboarding + pairing)
- [x] src/lib/server-session.ts (read better-auth session server-side -> account)
- [x] src/lib/account.ts (ensureAccount(email) -> accounts row)
- [x] src/lib/api/onboarding.ts (client: start, status)
- [x] src/lib/api/home.ts (client: sessions, afk, number)
- [x] src/lib/api/integrations.ts (client: pairing token / install command)

## shadcn ui primitives
- [x] button, card, badge, switch, dropdown-menu, tooltip, skeleton

## components
- [x] components/icons.tsx (ProbeMark/ProbeBrand — reuse glyph)
- [x] components/account-menu.tsx
- [x] components/onboarding-shell.tsx (centered shell + StepVisual + LoadingPane)
- [x] components/chat-bubble or message deep-link button

## routes (server)
- [x] api/idp/[...all]/route.ts (better-auth handler)
- [x] api/onboarding/start/route.ts (mint session-bound onboarding token)
- [x] api/onboarding/status/route.ts (poll for matched/verified number)
- [x] api/home/sessions/route.ts (account-scoped live sessions from CP/Neon)
- [x] api/home/afk/route.ts (toggle AFK across account sessions -> CP)
- [x] api/home/number/route.ts (linked verified number)
- [x] api/integrations/pairing-token/route.ts (mint single-use pairing token)

## pages
- [x] app/layout.tsx (fonts, Toaster, metadata)
- [x] app/page.tsx (root -> route by auth/onboarding state)
- [x] app/(auth)/layout.tsx + sign-in/page.tsx
- [x] app/onboarding/page.tsx (SSO -> welcome -> token -> deep link -> match -> confirm)
- [x] app/(dashboard)/layout.tsx + home page (chat deep-link, number, sessions, AFK)
- [x] app/integrations/page.tsx (install.sh one-liner w/ pairing token)

## Verify
- [x] tsc clean (isolated against mirrored Next 16.1.6 / React 19.2.3 /
      better-auth / pg / @imsg/shared types; injected-error sanity confirmed
      tsc is genuinely checking; no bun install in worktree; temp artifacts removed)
- [x] never hardcode enum strings; all enum values via @imsg/shared const-objects
- [x] scope: only apps/dashboard/** + tasks/ created; no other lane / root touched
</content>
</invoke>
