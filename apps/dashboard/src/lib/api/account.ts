/**
 * Client API for account-level actions. Same-origin route handlers under
 * /api/account.
 */

import { apiPost } from "@/lib/api/client";
import type { DeleteAccountResponse } from "@/lib/api/contracts";

/** Permanently delete the current account and all of its data. The server also
 *  destroys the Better Auth session, so the caller should redirect to /sign-in
 *  on success. */
export function deleteAccount(
  signal?: AbortSignal,
): Promise<DeleteAccountResponse> {
  return apiPost<DeleteAccountResponse>("/api/account/delete", {}, signal);
}
