/**
 * Client API for the onboarding flow. Talks to the dashboard's own
 * same-origin route handlers under /api/onboarding/*.
 */

import { apiGet, apiPost } from "@/lib/api/client";
import type {
  OnboardingStartResponse,
  OnboardingStatusResponse,
  RequestAccessRequest,
  RequestAccessResponse,
} from "@/lib/api/contracts";

/** Mint a single-use, session-bound onboarding token for the deep link. */
export function startOnboarding(
  signal?: AbortSignal,
): Promise<OnboardingStartResponse> {
  return apiPost<OnboardingStartResponse>("/api/onboarding/start", {}, signal);
}

/** Poll for whether the texted-in token has matched + derived a number. */
export function getOnboardingStatus(
  signal?: AbortSignal,
): Promise<OnboardingStatusResponse> {
  return apiGet<OnboardingStatusResponse>("/api/onboarding/status", signal);
}

/** Confirm the derived number — marks the conversation verified. */
export function confirmNumber(
  signal?: AbortSignal,
): Promise<OnboardingStatusResponse> {
  return apiPost<OnboardingStatusResponse>(
    "/api/onboarding/confirm",
    {},
    signal,
  );
}

/** Submit the invite-gate form: the phone the user wants, for operator review. */
export function requestAccess(
  phone: string,
  signal?: AbortSignal,
): Promise<RequestAccessResponse> {
  const body: RequestAccessRequest = { phone };
  return apiPost<RequestAccessResponse>(
    "/api/onboarding/request-access",
    body,
    signal,
  );
}
