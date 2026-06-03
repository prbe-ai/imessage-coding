"use client";

/**
 * One live Claude Code session row. Shows the cwd (or a fallback), the agent,
 * a status badge, a grant-level menu, a per-session AFK switch, and a relative
 * "last active" timestamp. Status badge colors follow DESIGN.md:
 * active=success, waiting=warning, idle=info, ended=outline.
 */

import { ChevronDown } from "lucide-react";

import {
  AfkState,
  AgentKind,
  SessionState,
  GrantLevel,
  type SessionInfo,
} from "@imsg/shared";
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

/** Per-level menu copy. A session grant auto-approves tools whenever the agent
 *  runs (not only while AFK), so the wording avoids implying an AFK gate. */
const GRANT_DESC: Record<GrantLevel, string> = {
  [GrantLevel.OFF]: "Nothing is auto-approved",
  [GrantLevel.EDITS]: "Auto-approve file edits only",
  [GrantLevel.FULL]: "Auto-approve every action",
};

/** Menu order, least to most permissive. Picking a level sets it directly, so
 *  lowering edits→off never passes through the all-tools `full` state. */
const GRANT_ORDER = [
  GrantLevel.OFF,
  GrantLevel.EDITS,
  GrantLevel.FULL,
] as const;

/** Coding-agent → brand icon, served from `public/icons`. Keyed by AgentKind so
 *  adding an agent is a compile error here until its asset is mapped. `agent` is
 *  an unchecked DB string at the edge, so reads fall back to the Claude mark
 *  rather than render a broken <img> for an unmapped value. */
const AGENT_ICON: Record<AgentKind, string> = {
  [AgentKind.CLAUDE_CODE]: "/icons/claude-code.svg",
};

export function SessionCard({
  session,
  onToggleAfk,
  onSetGrant,
  busy,
  grantBusy,
}: {
  session: SessionInfo;
  onToggleAfk: (next: AfkState) => void;
  onSetGrant: (next: GrantLevel) => void;
  busy: boolean;
  grantBusy: boolean;
}) {
  // Prefer the captured task title; fall back to the cwd basename, then a stub.
  // When a title is present the folder is demoted to the meta row so it's not lost.
  const folder = session.cwd?.split("/").filter(Boolean).pop() ?? session.cwd ?? undefined;
  const label = session.title ?? folder ?? "Untitled session";
  const tooltip = session.title
    ? session.cwd
      ? `${session.title}\n${session.cwd}`
      : session.title
    : (session.cwd ?? undefined);
  return (
    <div className="rounded-lg border border-outline-variant/40 bg-surface-container-low p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-bold tracking-tight text-on-surface">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-outline-variant/50 bg-white p-0.5">
              {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG from /public, next/image adds no value */}
              <img
                src={AGENT_ICON[session.agent] ?? AGENT_ICON[AgentKind.CLAUDE_CODE]}
                alt={session.agent}
                className="size-full"
              />
            </span>
            <span className="line-clamp-1" title={tooltip}>
              {label}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-outline">
            {session.title && folder ? (
              <>
                <span className="normal-case">{folder}</span>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={grantBusy}
              aria-label={`Auto-approve: ${GRANT_LABEL[session.grant]}. Change level.`}
              className={cn(
                "inline-flex items-center gap-1 rounded font-mono text-[10px] uppercase tracking-widest transition-colors",
                "cursor-pointer text-outline hover:text-on-surface-variant",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {GRANT_LABEL[session.grant]}
              <ChevronDown className="size-3" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={6}
            className="onb-account-menu min-w-56"
          >
            <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-widest text-outline">
              Auto-approve for this session
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={session.grant}
              onValueChange={(v) => {
                if (v !== session.grant) onSetGrant(v as GrantLevel);
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
