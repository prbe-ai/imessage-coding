"use client";

/**
 * Root router. Decides where a visitor lands:
 *   - no session                    → /sign-in
 *   - signed in, no number          → /onboarding (text-in the code to link)
 *   - signed in, verified, unpaired → /onboarding (finish at the pair step)
 *   - signed in, verified + paired  → /home
 *
 * Kept as a thin client gate (no SSR redirect) so the Better Auth session is
 * read with the same client the rest of the app uses.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useSession } from "@/lib/idp/better-auth-client";
import { getLinkedNumber } from "@/lib/api/home";

export default function RootPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  useEffect(() => {
    if (isPending) return;
    if (!session) {
      router.replace("/sign-in");
      return;
    }
    const ac = new AbortController();
    getLinkedNumber(ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        // Fully onboarded = number verified AND a device paired. A verified
        // account with no device still has onboarding to finish (the pair
        // step), so send it back to /onboarding rather than /home.
        router.replace(res.verified && res.hasDevice ? "/home" : "/onboarding");
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        // On any error, send them to onboarding — it re-derives status and
        // is safe to re-enter.
        router.replace("/onboarding");
      });
    return () => ac.abort();
  }, [session, isPending, router]);

  return (
    <div className="onb-root onb-centered-page">
      <main className="onb-centered-main">
        <div className="onb-loading-block">
          <Loader2 className="onb-spin" aria-hidden="true" />
          <p className="onb-loading-msg">One moment…</p>
        </div>
      </main>
    </div>
  );
}
