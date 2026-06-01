/**
 * Dashboard SSE ticket verification.
 *
 * The dashboard browser opens an account-scoped EventSource directly against the
 * control plane (the single SSE hub). EventSource can't send an Authorization
 * header and the Better Auth cookie is host-scoped to the dashboard origin, so
 * auth rides as a short-TTL HMAC ticket in the `?ticket=` query param.
 *
 * The dashboard mints the ticket server-side (it holds the Better Auth session)
 * with the SAME shared secret (SSE_TICKET_SECRET) — see the dashboard's
 * `lib/sse-ticket.ts`; the two MUST stay format-identical:
 *
 *   payload = `${accountId}.${expEpochSeconds}`
 *   ticket  = base64url(payload) + "." + base64url(HMAC_SHA256(secret, payload))
 *
 * Fail-closed: an unset secret (not yet provisioned), a bad signature, or an
 * expired ticket all return null → the route 401s. The secret is never sent to
 * the browser; the minted ticket is opaque and expires quickly.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../env.ts';

export interface DashboardAuth {
  accountId: string;
}

/** Verify a dashboard SSE ticket; returns the account it authorizes, or null. */
export function verifySseTicket(ticket: string): DashboardAuth | null {
  const { sseTicketSecret } = loadEnv();
  if (!sseTicketSecret) return null; // not provisioned → no valid tickets exist

  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot >= ticket.length - 1) return null;
  const payloadB64 = ticket.slice(0, dot);
  const sigB64 = ticket.slice(dot + 1);

  let payload: string;
  let provided: Buffer;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    provided = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }

  const expected = createHmac('sha256', sseTicketSecret).update(payload).digest();
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return null;
  }

  // payload = "<accountId>.<expSec>"; accountId is a UUID (no dots), exp is digits.
  const sep = payload.lastIndexOf('.');
  if (sep <= 0) return null;
  const accountId = payload.slice(0, sep);
  const expSec = Number.parseInt(payload.slice(sep + 1), 10);
  if (!accountId || !Number.isFinite(expSec) || expSec * 1000 < Date.now()) return null;

  return { accountId };
}
