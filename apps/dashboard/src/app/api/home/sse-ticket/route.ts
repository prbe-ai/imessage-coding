/**
 * GET /api/home/sse-ticket — mint a short-TTL ticket + return the control-plane
 * SSE URL the browser opens an EventSource against.
 *
 * The control plane is the single SSE hub. The dashboard browser can't reach it
 * with the Better Auth cookie (different origin) or an Authorization header
 * (EventSource limitation), so this same-origin route (cookie-authed via
 * requireAccount) hands the browser an opaque, account-scoped ticket + the
 * absolute EVENTS url. The browser then connects directly to the control plane.
 */

import { NextResponse } from "next/server";

import { requireAccount } from "@/lib/server-session";
import { ENV } from "@/lib/idp/env";
import { mintSseTicket } from "@/lib/sse-ticket";
import { DashboardApiRoute } from "@imsg/shared";
import type { SseTicketResponse } from "@/lib/api/contracts";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const ctx = await requireAccount(req);
  if (!ctx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let ticket: string;
  try {
    ticket = mintSseTicket(ctx.accountId);
  } catch {
    // SSE_TICKET_SECRET not provisioned yet — fail soft. The client treats this
    // as "no live stream" and keeps its initial snapshot + reconnect attempts.
    return NextResponse.json({ error: "sse_unconfigured" }, { status: 503 });
  }

  const body: SseTicketResponse = {
    ticket,
    url: `${ENV.controlPlaneUrl()}${DashboardApiRoute.EVENTS}`,
  };
  return NextResponse.json(body, { status: 200 });
}
