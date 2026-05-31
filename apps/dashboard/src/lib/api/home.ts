/**
 * Client API for the Home page: the linked phone number, the live sessions
 * list, and the AFK / grant toggles. Same-origin route handlers under
 * /api/home/*.
 */

import { apiGet, apiPost } from "@/lib/api/client";
import type { AfkState, GrantLevel } from "@imsg/shared";
import type {
  LinkedNumberResponse,
  SessionsResponse,
  SetAfkResponse,
  SetGrantResponse,
} from "@/lib/api/contracts";

export function getLinkedNumber(
  signal?: AbortSignal,
): Promise<LinkedNumberResponse> {
  return apiGet<LinkedNumberResponse>("/api/home/number", signal);
}

export function listSessions(signal?: AbortSignal): Promise<SessionsResponse> {
  return apiGet<SessionsResponse>("/api/home/sessions", signal);
}

export function setAfk(
  afk: AfkState,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<SetAfkResponse> {
  return apiPost<SetAfkResponse>("/api/home/afk", { afk, sessionId }, signal);
}

export function setGrant(
  grant: GrantLevel,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<SetGrantResponse> {
  return apiPost<SetGrantResponse>(
    "/api/home/grant",
    { grant, sessionId },
    signal,
  );
}
