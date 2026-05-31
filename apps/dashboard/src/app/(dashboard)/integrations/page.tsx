"use client";

/**
 * Integrations page.
 *
 * Surfaces the one-line install command with an embedded single-use pairing
 * token (`curl -fsSL …/install.sh | TOKEN=… sh`). The install script exchanges
 * the token at the control plane for a long-lived device_token, enables the
 * Claude Code plugin, and wires up the status line. The token is single-use and
 * short-TTL; "Generate a new command" re-issues and burns the prior one.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Loader2, RefreshCw, Terminal } from "lucide-react";
import { toast } from "sonner";

import { useSession } from "@/lib/idp/better-auth-client";
import { DashboardChrome } from "@/components/dashboard-chrome";
import { Button } from "@/components/ui/button";
import { mintPairingToken } from "@/lib/api/integrations";
import { extractError } from "@/lib/utils";

export default function IntegrationsPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  const [installCommand, setInstallCommand] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState(false);
  const bootRef = useRef(false);

  const mint = useCallback(async () => {
    setMinting(true);
    try {
      const res = await mintPairingToken();
      setInstallCommand(res.installCommand);
      setCopied(false);
    } catch (err) {
      toast.error(extractError(err, "Couldn't generate an install command."));
    } finally {
      setMinting(false);
    }
  }, []);

  // ── Boot: gate auth, mint the first token. ────────────────────────────
  useEffect(() => {
    if (bootRef.current) return;
    if (isPending) return;
    if (!session) {
      router.replace("/sign-in");
      return;
    }
    bootRef.current = true;
    // Defer the mint kickoff to a microtask so its synchronous setMinting(true)
    // runs after this effect commits rather than within the effect body (avoids
    // a cascading-render lint error while still firing on boot).
    queueMicrotask(() => void mint());
  }, [session, isPending, router, mint]);

  const onCopy = useCallback(async () => {
    if (!installCommand) return;
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      toast.success("Copied install command");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select and copy manually.");
    }
  }, [installCommand]);

  const userEmail = session?.user?.email ?? null;

  return (
    <DashboardChrome email={userEmail}>
      <div className="space-y-8">
        <div className="space-y-2">
          <h1 className="text-3xl font-extrabold tracking-tight">
            Pair a device
          </h1>
          <p className="max-w-prose text-sm text-on-surface-variant">
            Run this one-liner on the machine where you use Claude Code. It
            installs the Probe plugin, links the device to your account, and
            sets up the status line. The token is single-use — generate a fresh
            command for each machine.
          </p>
        </div>

        <section className="space-y-3">
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-outline">
            <Terminal className="size-3" aria-hidden="true" />
            Install command
          </div>

          <div className="relative rounded-lg border border-outline-variant/40 bg-surface-container-low p-4 pr-28">
            {installCommand ? (
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-on-surface">
                {installCommand}
              </pre>
            ) : (
              <div className="flex items-center gap-2 text-sm text-on-surface-variant">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Generating…
              </div>
            )}
            <div className="absolute right-3 top-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void onCopy()}
                disabled={!installCommand}
              >
                {copied ? (
                  <Check className="size-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="size-3.5" aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs text-outline">
              Single-use and short-lived. Re-generate if it expires.
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void mint()}
              disabled={minting}
            >
              <RefreshCw
                className={`size-3.5${minting ? " animate-spin" : ""}`}
                aria-hidden="true"
              />
              Generate a new command
            </Button>
          </div>
        </section>

        <section className="rounded-lg border border-prbe-info/30 bg-prbe-info/5 p-4">
          <h2 className="text-sm font-semibold text-on-surface">
            What happens next
          </h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-on-surface-variant">
            <li>The script pairs this device and stores a device token.</li>
            <li>
              Start Claude Code — your session shows up live on the{" "}
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
