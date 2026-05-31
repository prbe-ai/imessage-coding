/**
 * Better Auth catch-all route handler (self-hosted, Google-only).
 *
 * Better Auth ships its full HTTP surface (sign-in, session, OAuth callbacks)
 * as a single handler. Mounted at `/api/idp/*` to match `basePath: "/api/idp"`
 * in src/lib/idp/auth.ts.
 *
 * Lazy init: `getAuth()` constructs the instance on first request, so
 * `next build` never needs DATABASE_URL / BETTER_AUTH_SECRET / BETTER_AUTH_URL.
 *
 * Source: https://www.better-auth.com/docs/integrations/next
 */

import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/lib/idp/auth";

export const dynamic = "force-dynamic";

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Handlers = Record<HttpMethod, (req: Request) => Promise<Response>>;

let handlers: Handlers | null = null;
function getHandlers(): Handlers {
  if (!handlers) {
    handlers = toNextJsHandler(getAuth()) as Handlers;
  }
  return handlers;
}

export function GET(req: Request): Promise<Response> | Response {
  return getHandlers().GET(req);
}
export function POST(req: Request): Promise<Response> | Response {
  return getHandlers().POST(req);
}
export function PATCH(req: Request): Promise<Response> | Response {
  return getHandlers().PATCH(req);
}
export function PUT(req: Request): Promise<Response> | Response {
  return getHandlers().PUT(req);
}
export function DELETE(req: Request): Promise<Response> | Response {
  return getHandlers().DELETE(req);
}
