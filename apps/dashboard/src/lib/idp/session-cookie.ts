/**
 * The app session cookie name.
 *
 * A standard HttpOnly session-cookie pattern: a cookie that
 * carries the authenticated session. Here the dashboard and control plane
 * share one Neon database, so the dashboard reads the Better Auth session
 * directly server-side (see src/lib/server-session.ts) rather than minting a
 * separate JWT for a remote backend. This constant names the Better Auth
 * session-token cookie the dashboard origin sets.
 */
export const IMSG_SESSION_COOKIE_NAME = "imsg_session" as const;

/** Better Auth's own session-token cookie name (default). */
export const BETTER_AUTH_SESSION_COOKIE = "better-auth.session_token" as const;
