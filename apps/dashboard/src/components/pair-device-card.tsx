"use client";

/**
 * The install-command section: mints a single-use pairing token on mount and
 * renders the ready-to-paste `curl … | TOKEN=… sh` one-liner with copy +
 * regenerate. Shared by the Integrations page and the onboarding install step so
 * both pair a device through the exact same UI. The token is single-use and
 * short-TTL; "Generate a new command" re-issues and burns the prior one.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Terminal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CommandBlock } from "@/components/command-block";
import { mintPairingToken } from "@/lib/api/integrations";
import { extractError } from "@/lib/utils";

export function PairDeviceCard() {
  const [installCommand, setInstallCommand] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const bootRef = useRef(false);

  const mint = useCallback(async () => {
    setMinting(true);
    try {
      const res = await mintPairingToken();
      setInstallCommand(res.installCommand);
    } catch (err) {
      toast.error(extractError(err, "Couldn't generate an install command."));
    } finally {
      setMinting(false);
    }
  }, []);

  // Mint the first token on mount. Deferred to a microtask so its synchronous
  // setMinting(true) runs after this effect commits (avoids a cascading-render
  // lint error while still firing on boot).
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    queueMicrotask(() => void mint());
  }, [mint]);

  return (
    <section className="space-y-3">
      <CommandBlock
        label="Install command"
        icon={<Terminal className="size-3" aria-hidden="true" />}
        command={installCommand}
        copyToastLabel="Copied install command"
      />

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
  );
}
