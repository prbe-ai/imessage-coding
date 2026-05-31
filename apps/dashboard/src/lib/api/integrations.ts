/**
 * Client API for the Integrations page: mint a single-use pairing token and
 * get the ready-to-paste install one-liner. Same-origin route handler at
 * /api/integrations/pairing-token.
 */

import { apiPost } from "@/lib/api/client";
import type { PairingTokenResponse } from "@/lib/api/contracts";

/** Mint a fresh single-use pairing token + install command. */
export function mintPairingToken(
  signal?: AbortSignal,
): Promise<PairingTokenResponse> {
  return apiPost<PairingTokenResponse>(
    "/api/integrations/pairing-token",
    {},
    signal,
  );
}
