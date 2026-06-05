"use client";

/**
 * A labeled, copy-able shell-command box. The shared presentational unit behind
 * the Integrations page (install + uninstall), the onboarding install step, and
 * the delete-account modal — so every place that shows a one-liner looks and
 * behaves identically. Pass `command={null}` to show a loading shimmer while a
 * token is minting.
 */

import { type ReactNode, useCallback, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

export function CommandBlock({
  label,
  icon,
  command,
  copyToastLabel,
}: {
  label: string;
  icon?: ReactNode;
  /** The command to render, or null while it is still being generated. */
  command: string | null;
  /** Toast shown after a successful copy. */
  copyToastLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast.success(copyToastLabel);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select and copy manually.");
    }
  }, [command, copyToastLabel]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-outline">
        {icon}
        {label}
      </div>

      <div className="relative rounded-lg border border-outline-variant/40 bg-surface-container-low p-4 pr-28">
        {command ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-on-surface">
            {command}
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
            disabled={!command}
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
    </div>
  );
}
