"use client";

/**
 * One live Claude Code session row. Shows the cwd (or a fallback), the agent,
 * a status badge, the standing grant level, a per-session AFK switch, and a
 * relative "last active" timestamp. Status badge colors follow DESIGN.md:
 * active=success, waiting=warning, idle=info, ended=outline.
 */

import { Folder } from "lucide-react";

import {
  AfkState,
  SessionState,
  GrantLevel,
  type SessionInfo,
} from "@imsg/shared";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/utils";

/** Tailwind classes for a session-state badge — `bg-{semantic}/20 text-{semantic}`. */
const STATE_BADGE: Record<SessionState, string> = {
  [SessionState.ACTIVE]: "bg-status-success/20 text-status-success",
  [SessionState.WAITING]: "bg-status-warning/20 text-status-warning",
  [SessionState.IDLE]: "bg-status-info/20 text-status-info",
  [SessionState.ENDED]: "bg-outline-variant/30 text-outline",
};

const STATE_LABEL: Record<SessionState, string> = {
  [SessionState.ACTIVE]: "Active",
  [SessionState.WAITING]: "Waiting",
  [SessionState.IDLE]: "Idle",
  [SessionState.ENDED]: "Ended",
};

const GRANT_LABEL: Record<GrantLevel, string> = {
  [GrantLevel.OFF]: "Grant off",
  [GrantLevel.EDITS]: "Edits",
  [GrantLevel.FULL]: "Full auto",
};

export function SessionCard({
  session,
  onToggleAfk,
  busy,
}: {
  session: SessionInfo;
  onToggleAfk: (next: AfkState) => void;
  busy: boolean;
}) {
  const cwd = session.cwd?.split("/").filter(Boolean).pop() ?? session.cwd;
  return (
    <div className="rounded-lg border border-outline-variant/40 bg-surface-container-low p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-bold tracking-tight text-on-surface">
            <Folder className="size-4 shrink-0 text-on-surface-variant" />
            <span className="line-clamp-1" title={session.cwd ?? undefined}>
              {cwd || "Untitled session"}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-outline">
            <span>{session.agent}</span>
            <span aria-hidden="true">·</span>
            <span>updated {formatRelativeTime(session.lastEventAt)}</span>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded px-2 py-0.5 text-[11px] font-semibold uppercase",
            STATE_BADGE[session.state],
          )}
        >
          {STATE_LABEL[session.state]}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-outline-variant/30 pt-3">
        <span className="font-mono text-[10px] uppercase tracking-widest text-outline">
          {GRANT_LABEL[session.grant]}
        </span>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-on-surface-variant">
          <span>AFK</span>
          <Switch
            checked={session.afk === AfkState.ON}
            onCheckedChange={(checked) =>
              onToggleAfk(checked ? AfkState.ON : AfkState.OFF)
            }
            disabled={busy}
            aria-label="Toggle away-from-keyboard for this session"
          />
        </label>
      </div>
    </div>
  );
}
