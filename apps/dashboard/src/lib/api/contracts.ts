/**
 * Wire contracts shared between the dashboard's client API modules and its
 * own server-side route handlers. Keeping them in one module means the
 * browser code and the route handler can't drift on field names.
 */

import type { AfkState, GrantLevel, SessionInfo } from "@imsg/shared";

// ── Onboarding ──────────────────────────────────────────────────────────

/** Response of POST /api/onboarding/start — the freshly minted, single-use,
 *  session-bound onboarding token (raw, shown once) for the deep link. */
export interface OnboardingStartResponse {
  /** Raw onboarding token to embed in the prefilled iMessage body. */
  token: string;
  /** ISO-8601 expiry of the token. */
  expiresAt: string;
  /** The agent number (E.164) the user should text — addresses the deep link. */
  agentNumber: string;
}

/** A derived phone number awaiting the user's confirmation, or the
 *  already-verified number once confirmed. */
export interface OnboardingStatusResponse {
  /** Whether an inbound message has matched the active onboarding token. */
  matched: boolean;
  /** The derived phone number (E.164), present once `matched` is true. */
  phoneNumber: string | null;
  /** Whether the number is fully verified (conversation.verified_at set). */
  verified: boolean;
}

// ── Home ────────────────────────────────────────────────────────────────

/** Response of GET /api/home/number — the user's linked, verified number. */
export interface LinkedNumberResponse {
  phoneNumber: string | null;
  verified: boolean;
}

/** Response of GET /api/account/agent-number — the AgentPhone number assigned
 *  to this account (the number the user texts/chats). NULL only when the pool
 *  is empty. Distinct from LinkedNumberResponse, which is the user's OWN
 *  verified number. */
export interface AgentNumberResponse {
  phoneNumber: string | null;
}

/** Response of GET /api/home/sessions — live, account-scoped sessions. Also the
 *  shape of each `sessions` SSE event pushed by the control plane. */
export interface SessionsResponse {
  sessions: SessionInfo[];
}

/** Response of GET /api/home/sse-ticket — a short-TTL ticket + the absolute
 *  control-plane SSE URL the browser opens an EventSource against. The dashboard
 *  is on a different origin than the control plane, so the browser needs both. */
export interface SseTicketResponse {
  /** Opaque HMAC ticket; passed as the `?ticket=` query param to `url`. */
  ticket: string;
  /** Absolute control-plane SSE endpoint (DashboardApiRoute.EVENTS). */
  url: string;
}

/** Body of POST /api/home/afk — set AFK across the account's live sessions. */
export interface SetAfkRequest {
  afk: AfkState;
  /** Optional: scope to one session; omitted = all live sessions. */
  sessionId?: string;
}

export interface SetAfkResponse {
  afk: AfkState;
  /** Number of sessions updated. */
  updated: number;
}

/** Body of POST /api/home/grant — set the standing grant level. */
export interface SetGrantRequest {
  grant: GrantLevel;
  sessionId?: string;
}

export interface SetGrantResponse {
  grant: GrantLevel;
  updated: number;
}

// ── Integrations ──────────────────────────────────────────────────────────

/** Response of POST /api/integrations/pairing-token — a single-use pairing
 *  token plus the ready-to-paste install one-liner. */
export interface PairingTokenResponse {
  token: string;
  expiresAt: string;
  /** The full `curl … | TOKEN=… sh` install command. */
  installCommand: string;
}
