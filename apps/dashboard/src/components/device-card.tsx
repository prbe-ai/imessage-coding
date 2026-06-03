"use client";

/**
 * One paired machine. AFK + session grant are MACHINE-WIDE (the PreToolUse hook
 * reads one shared state file per device), so the controls live here, once per
 * device — and the device's live sessions nest underneath. Toggling AFK or grant
 * here flips the whole machine; every session card below reflects it.
 */

import { ChevronDown, Monitor } from "lucide-react";

import {
  AfkState,
  GrantLevel,
  type DeviceInfo,
  type SessionInfo,
} from "@imsg/shared";
import { SessionCard } from "@/components/session-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const GRANT_LABEL: Record<GrantLevel, string> = {
  [GrantLevel.OFF]: "Grant off",
  [GrantLevel.EDITS]: "Edits",
  [GrantLevel.FULL]: "Full auto",
};

/** Per-level menu copy. A grant auto-approves tools whenever an agent runs (not
 *  only while AFK), and it applies to the whole machine — wording reflects both. */
const GRANT_DESC: Record<GrantLevel, string> = {
  [GrantLevel.OFF]: "Nothing is auto-approved",
  [GrantLevel.EDITS]: "Auto-approve file edits only",
  [GrantLevel.FULL]: "Auto-approve every action",
};

/** Menu order, least to most permissive. Picking a level sets it directly, so
 *  lowering edits→off never passes through the all-tools `full` state. */
const GRANT_ORDER = [GrantLevel.OFF, GrantLevel.EDITS, GrantLevel.FULL] as const;

export function DeviceCard({
  device,
  sessions,
  onToggleAfk,
  onSetGrant,
  afkBusy,
  grantBusy,
}: {
  device: DeviceInfo;
  sessions: SessionInfo[];
  onToggleAfk: (next: AfkState) => void;
  onSetGrant: (next: GrantLevel) => void;
  afkBusy: boolean;
  grantBusy: boolean;
}) {
  return (
    <div className="rounded-xl border border-outline-variant/40 bg-surface-container-lowest">
      {/* Device header: label + machine-wide AFK + grant. */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Monitor className="size-4 shrink-0 text-outline" aria-hidden="true" />
          <span
            className="line-clamp-1 text-sm font-bold tracking-tight text-on-surface"
            title={device.hostname ?? device.os ?? device.id}
          >
            {device.label}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-widest text-outline">
            {device.os ? `${device.os} · ` : ""}
            {device.sessionCount} live
          </span>
          {!device.enabled && (
            <span className="rounded bg-outline-variant/30 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-outline">
              Disabled
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={grantBusy}
                aria-label={`Auto-approve: ${GRANT_LABEL[device.grant]}. Change level for this machine.`}
                className={cn(
                  "inline-flex items-center gap-1 rounded font-mono text-[10px] uppercase tracking-widest transition-colors",
                  "cursor-pointer text-outline hover:text-on-surface-variant",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {GRANT_LABEL[device.grant]}
                <ChevronDown className="size-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={6}
              className="onb-account-menu min-w-56"
            >
              <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-widest text-outline">
                Auto-approve on this machine
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={device.grant}
                onValueChange={(v) => {
                  if (v !== device.grant) onSetGrant(v as GrantLevel);
                }}
              >
                {GRANT_ORDER.map((level) => (
                  <DropdownMenuRadioItem
                    key={level}
                    value={level}
                    className={cn(
                      "cursor-pointer focus:bg-surface-container-high",
                      level === GrantLevel.FULL &&
                        "text-status-warning focus:text-status-warning",
                    )}
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm">{GRANT_LABEL[level]}</span>
                      <span className="text-xs text-on-surface-variant">
                        {GRANT_DESC[level]}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-on-surface-variant">
            <span>AFK</span>
            <Switch
              checked={device.afk === AfkState.ON}
              onCheckedChange={(checked) =>
                onToggleAfk(checked ? AfkState.ON : AfkState.OFF)
              }
              disabled={afkBusy}
              aria-label={`Toggle away-from-keyboard for ${device.label}`}
            />
          </label>
        </div>
      </div>

      {/* The device's live sessions. */}
      <div className="space-y-2 border-t border-outline-variant/30 p-3">
        {sessions.length === 0 ? (
          <div className="py-4 text-center text-xs text-outline">
            No live sessions on this machine.
          </div>
        ) : (
          sessions.map((s) => <SessionCard key={s.id} session={s} />)
        )}
      </div>
    </div>
  );
}
