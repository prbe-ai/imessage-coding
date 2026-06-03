/**
 * Client API for the Home page: the linked phone number, the live sessions
 * list, and the AFK / grant toggles. Same-origin route handlers under
 * /api/home/*.
 */

import { apiGet, apiPost } from "@/lib/api/client";
import { DashboardApiRoute, type AfkState, type GrantLevel } from "@imsg/shared";
import type {
  AgentNumberResponse,
  DevicesResponse,
  LinkedNumberResponse,
  SessionsResponse,
  SetAfkResponse,
  SetGrantResponse,
  SseTicketResponse,
} from "@/lib/api/contracts";

export function getLinkedNumber(
  signal?: AbortSignal,
): Promise<LinkedNumberResponse> {
  return apiGet<LinkedNumberResponse>("/api/home/number", signal);
}

/** The agent number this account texts/chats — for the "Open chat" deep link.
 *  Distinct from getLinkedNumber (the user's own linked number). */
export function getAgentNumber(
  signal?: AbortSignal,
): Promise<AgentNumberResponse> {
  return apiGet<AgentNumberResponse>("/api/account/agent-number", signal);
}

export function listSessions(signal?: AbortSignal): Promise<SessionsResponse> {
  return apiGet<SessionsResponse>("/api/home/sessions", signal);
}

/** The account's paired devices — AFK/grant live per device (machine-wide). */
export function listDevices(signal?: AbortSignal): Promise<DevicesResponse> {
  return apiGet<DevicesResponse>("/api/home/devices", signal);
}

/** Mint a control-plane SSE ticket + the EVENTS url for the live sessions feed. */
export function getSseTicket(signal?: AbortSignal): Promise<SseTicketResponse> {
  return apiGet<SseTicketResponse>(DashboardApiRoute.SSE_TICKET, signal);
}

/** Set machine-wide AFK. `deviceId` targets one machine; omit it for all. */
export function setAfk(
  afk: AfkState,
  deviceId?: string,
  signal?: AbortSignal,
): Promise<SetAfkResponse> {
  return apiPost<SetAfkResponse>("/api/home/afk", { afk, deviceId }, signal);
}

/** Set the machine-wide grant level. `deviceId` targets one machine; omit for all. */
export function setGrant(
  grant: GrantLevel,
  deviceId?: string,
  signal?: AbortSignal,
): Promise<SetGrantResponse> {
  return apiPost<SetGrantResponse>(
    "/api/home/grant",
    { grant, deviceId },
    signal,
  );
}
