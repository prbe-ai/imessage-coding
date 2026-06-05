"use client";

/**
 * Integrations page.
 *
 * Surfaces the one-line install command with an embedded single-use pairing
 * token (`curl -fsSL …/install.sh | TOKEN=… sh`). The install script exchanges
 * the token at the control plane for a long-lived device_token, enables the
 * Claude Code plugin, and wires up the status line. The install/uninstall UI is
 * shared (PairDeviceCard / CommandBlock) with the onboarding install step and
 * the delete-account modal.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

import { useSession } from "@/lib/idp/better-auth-client";
import { DashboardChrome } from "@/components/dashboard-chrome";
import { CommandBlock } from "@/components/command-block";
import { PairDeviceCard } from "@/components/pair-device-card";
import { UNINSTALL_COMMAND } from "@/lib/uninstall";

export default function IntegrationsPage() {
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

  return (
    <DashboardChrome email={userEmail}>
      <div className="space-y-8">
        <div className="space-y-2">
          <h1 className="text-3xl font-extrabold tracking-tight">
            Pair a device
          </h1>
          <p className="max-w-prose text-sm text-on-surface-variant">
            Run this one-liner on the machine where you use Claude Code or Codex. It
            installs the Probe plugin, links the device to your account, and
            sets up the status line. The token is single-use — generate a fresh
            command for each machine.
          </p>
        </div>

        <PairDeviceCard />

        <section className="space-y-3">
          <CommandBlock
            label="Uninstall command"
            icon={<Trash2 className="size-3" aria-hidden="true" />}
            command={UNINSTALL_COMMAND}
            copyToastLabel="Copied uninstall command"
          />
          <p className="text-xs text-outline">
            Run on a paired machine to revert everything the installer did —
            restores your Claude Code / Codex settings, unregisters the plugin,
            and drops the device token. No pairing token needed.
          </p>
        </section>

        <section className="rounded-lg border border-status-info/30 bg-status-info/5 p-4">
          <h2 className="text-sm font-semibold text-on-surface">
            What happens next
          </h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-on-surface-variant">
            <li>The script pairs this device and stores a device token.</li>
            <li>
              Start Claude Code or Codex — your session shows up live on the{" "}
              <a className="text-primary underline" href="/home">
                Home
              </a>{" "}
              page.
            </li>
            <li>
              Toggle AFK there (or from iMessage) to route prompts to your
              phone.
            </li>
          </ol>
        </section>
      </div>
    </DashboardChrome>
  );
}
