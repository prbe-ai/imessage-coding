"use client";

/**
 * One live Claude Code session row. Shows the task title (or cwd fallback), the
 * agent, a status badge, and a relative "last active" timestamp. AFK is
 * MACHINE-WIDE, so it's controlled on the parent DeviceCard, not here. Status
 * badge colors follow DESIGN.md: active=success, waiting=warning, idle=info,
 * ended=outline.
 *
 * The title is click-to-edit when `onRename` is provided: it writes the session's
 * manual display name (the user-side counterpart to the agent's rename_session
 * tool). Enter or blur commits; Escape cancels; an empty value clears the override
 * and reverts to the auto-title. The parent owns the optimistic update + persist.
 */

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";

import {
  AgentKind,
  SESSION_TITLE_MAX_LEN,
  SessionState,
  type SessionInfo,
} from "@imsg/shared";
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
  [SessionState.ACTIVE]: "Working",
  [SessionState.WAITING]: "Waiting for answer",
  [SessionState.IDLE]: "Idle",
  [SessionState.ENDED]: "Ended",
};

/** Coding-agent → brand icon, served from `public/icons`. Partial: an agent
 *  without its own asset (e.g. a freshly-added AgentKind, or an unchecked DB
 *  string at the edge) falls back to the Claude mark below rather than render a
 *  broken <img>. Add a key here once the agent's brand SVG lands in `public/icons`. */
const AGENT_ICON: Partial<Record<AgentKind, string>> = {
  [AgentKind.CLAUDE_CODE]: "/icons/claude-code.svg",
  [AgentKind.CODEX]: "/icons/codex.svg",
};

export function SessionCard({
  session,
  onRename,
}: {
  session: SessionInfo;
  /** Persist a new display name (empty string clears it). Omit to make the
   *  title read-only (e.g. an ended session). */
  onRename?: (name: string) => void;
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

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Escape sets this so the shared blur-commit path discards instead of saving.
  const cancelRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    if (!onRename) return;
    cancelRef.current = false;
    setDraft(session.title ?? "");
    setEditing(true);
  };

  // Single commit path (Enter + Escape both blur the input). No-op when unchanged
  // from the current effective title, so re-saving the same name is free.
  const commit = () => {
    setEditing(false);
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    const next = draft.trim();
    if (next === (session.title ?? "")) return;
    onRename?.(next);
  };

  return (
    <div className="rounded-lg border border-outline-variant/40 bg-surface-container-low p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-bold tracking-tight text-on-surface">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-outline-variant/50 bg-white p-0.5">
              {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG from /public, next/image adds no value */}
              <img
                src={AGENT_ICON[session.agent] ?? AGENT_ICON[AgentKind.CLAUDE_CODE]}
                alt={session.agent}
                className="size-full"
              />
            </span>
            {editing ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    inputRef.current?.blur();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRef.current = true;
                    inputRef.current?.blur();
                  }
                }}
                placeholder={folder ?? "Name this session"}
                aria-label="Session name"
                maxLength={SESSION_TITLE_MAX_LEN}
                className="min-w-0 flex-1 rounded border border-outline-variant/60 bg-surface-container px-1.5 py-0.5 text-sm font-bold text-on-surface outline-none focus:border-primary"
              />
            ) : onRename ? (
              <button
                type="button"
                onClick={startEdit}
                title={tooltip ? `${tooltip}\n(click to rename)` : "Click to rename"}
                aria-label={`Rename session: ${label}`}
                className="group/title flex min-w-0 items-center gap-1 text-left"
              >
                <span className="line-clamp-1">{label}</span>
                <Pencil
                  className="size-3 shrink-0 text-outline opacity-0 transition-opacity group-hover/title:opacity-100"
                  aria-hidden="true"
                />
              </button>
            ) : (
              <span className="line-clamp-1" title={tooltip}>
                {label}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs tracking-tight text-outline">
            {session.title && folder ? (
              <>
                <span>{folder}</span>
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
    </div>
  );
}
