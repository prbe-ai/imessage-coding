"use client";

/**
 * Settings page.
 *
 * Reached from the account menu (click your email → Settings). Shows the
 * signed-in identity and a danger zone with account deletion. Gates on the
 * Better Auth session only (no linked-number requirement) so a half-onboarded
 * account can still be deleted.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useSession } from "@/lib/idp/better-auth-client";
import { DashboardChrome } from "@/components/dashboard-chrome";
import { DeleteAccountDialog } from "@/components/delete-account-dialog";

export default function SettingsPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const bootRef = useRef(false);

  // ── Boot: gate auth. ──────────────────────────────────────────────────
  useEffect(() => {
    if (bootRef.current) return;
    if (isPending) return;
    if (!session) {
      router.replace("/sign-in");
      return;
    }
    bootRef.current = true;
  }, [session, isPending, router]);

  const userEmail = session?.user?.email ?? null;

  if (isPending || !session) {
    return (
      <DashboardChrome email={userEmail}>
        <div className="flex items-center justify-center py-24 text-on-surface-variant">
          <Loader2 className="size-5 animate-spin" aria-hidden="true" />
        </div>
      </DashboardChrome>
    );
  }

  return (
    <DashboardChrome email={userEmail}>
      <div className="space-y-8">
        <div className="space-y-2">
          <h1 className="text-3xl font-extrabold tracking-tight">Settings</h1>
          <p className="max-w-prose text-sm text-on-surface-variant">
            Manage your account.
          </p>
        </div>

        <section className="space-y-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-outline">
            Account
          </div>
          <div className="rounded-lg border border-outline-variant/40 bg-surface-container-low px-4 py-3">
            <div className="text-xs tracking-tight text-outline">
              Signed in as
            </div>
            <div className="mt-0.5 font-mono text-sm text-on-surface">
              {userEmail}
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-status-error">
            Danger zone
          </div>
          <div className="flex flex-col gap-4 rounded-lg border border-status-error/30 bg-status-error/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-on-surface">
                Delete account
              </h2>
              <p className="max-w-prose text-sm text-on-surface-variant">
                Permanently delete your account and all of its data — your linked
                number, paired devices, sessions, and message history. This can&apos;t
                be undone.
              </p>
            </div>
            <DeleteAccountDialog />
          </div>
        </section>
      </div>
    </DashboardChrome>
  );
}
