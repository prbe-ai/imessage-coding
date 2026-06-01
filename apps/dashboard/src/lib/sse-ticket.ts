/**
 * Dashboard SSE ticket minting.
 *
 * The dashboard browser opens an account-scoped EventSource directly against the
 * control plane (the single SSE hub). EventSource can't send an Authorization
 * header and the Better Auth cookie is host-scoped to this origin, so the
 * dashboard server (which holds the session) mints a short-TTL HMAC ticket the
 * browser passes as `?ticket=`.
 *
 * The control plane verifies with the SAME shared secret (SSE_TICKET_SECRET) —
 * see apps/control-plane/src/auth/dashboard.ts. The two MUST stay
 * format-identical:
 *
 *   payload = `${accountId}.${expEpochSeconds}`
 *   ticket  = base64url(payload) + "." + base64url(HMAC_SHA256(secret, payload))
 *
 * Server-only — it reads the secret.
 */

import "server-only";

import { createHmac } from "node:crypto";

import { ENV } from "@/lib/idp/env";

/** Ticket lifetime. Short: it only needs to survive from mint to EventSource
 *  connect; the stream then lives on its own. The browser re-mints on reconnect. */
const TICKET_TTL_SEC = 120;

export function mintSseTicket(accountId: string): string {
  const secret = ENV.sseTicketSecret();
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SEC;
  const payload = `${accountId}.${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  return `${payloadB64}.${sig}`;
}
