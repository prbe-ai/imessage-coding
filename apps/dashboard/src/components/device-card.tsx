"use client";

/**
 * One paired machine. AFK is MACHINE-WIDE (the PreToolUse hook reads one shared
 * state file per device), so the control lives here, once per device — and the
 * device's live sessions nest underneath. Toggling AFK here flips the whole
 * machine; every session card below reflects it.
 */

import { Monitor } from "lucide-react";

import { AfkState, type DeviceInfo, type SessionInfo } from "@imsg/shared";
import { SessionCard } from "@/components/session-card";
import { Switch } from "@/components/ui/switch";

export function DeviceCard({
  device,
  sessions,
  onToggleAfk,
  onRenameSession,
  afkBusy,
}: {
  device: DeviceInfo;
  sessions: SessionInfo[];
  onToggleAfk: (next: AfkState) => void;
  /** Persist a session's manual display name (empty string clears it). */
  onRenameSession: (sessionId: string, name: string) => void;
  afkBusy: boolean;
}) {
  return (
    <div className="rounded-xl border border-outline-variant/40 bg-surface-container-lowest">
      {/* Device header: label + machine-wide AFK. */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Monitor className="size-4 shrink-0 text-outline" aria-hidden="true" />
          <span
            className="line-clamp-1 text-sm font-bold tracking-tight text-on-surface"
            title={device.hostname ?? device.os ?? device.id}
          >
            {device.label}
          </span>
          <span className="text-xs tracking-tight text-outline">
            {device.os ? `${device.os} · ` : ""}
            {device.sessionCount} live
          </span>
          {!device.enabled && (
            <span className="rounded bg-outline-variant/30 px-1.5 py-0.5 text-xs tracking-tight text-outline">
              Disabled
            </span>
          )}
        </div>

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

      {/* The device's live sessions. */}
      <div className="space-y-2 border-t border-outline-variant/30 p-3">
        {sessions.length === 0 ? (
          <div className="py-4 text-center text-xs text-outline">
            No live sessions on this machine.
          </div>
        ) : (
          sessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              onRename={(name) => onRenameSession(s.id, name)}
            />
          ))
        )}
      </div>
    </div>
  );
}
