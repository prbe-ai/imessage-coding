"use client";

/**
 * Home page.
 *
 * - iMessage "Chat" deep-link button (opens Messages to the agent number).
 * - The linked, verified phone number.
 * - An account-wide AFK master toggle (sets AFK across every live session).
 * - A live Sessions list (per device/agent), polled from the control plane
 *   via the dashboard's own /api/home/sessions.
 *
 * Gates on the Better Auth session; bounces unauthenticated visitors to
 * /sign-in and un-linked accounts to /onboarding.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MessageSquare } from "lucide-react";
import { toast } from "sonner";

import { useSession } from "@/lib/idp/better-auth-client";
import { DashboardChrome } from "@/components/dashboard-chrome";
import { SessionCard } from "@/components/session-card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { AfkState, SessionState, type SessionInfo } from "@imsg/shared";
import {
  getAgentNumber,
  getLinkedNumber,
  listSessions,
  setAfk,
} from "@/lib/api/home";
import { chatDeepLink } from "@/lib/deep-link";
import { extractError } from "@/lib/utils";

/** Live-state refresh cadence for the sessions list. */
const SESSIONS_POLL_INTERVAL_MS = 5000;

export default function HomePage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  // The agent number to chat WITH (distinct from phoneNumber, the user's own).
  const [agentNumber, setAgentNumber] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [afkBusy, setAfkBusy] = useState(false);
  const bootRef = useRef(false);

  // ── Boot: gate auth + linked number. ──────────────────────────────────
  useEffect(() => {
    if (bootRef.current) return;
    if (isPending) return;
    if (!session) {
      router.replace("/sign-in");
      return;
    }
    bootRef.current = true;
    const ac = new AbortController();
    getLinkedNumber(ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        if (!res.verified) {
          router.replace("/onboarding");
          return;
        }
        setPhoneNumber(res.phoneNumber);
        // The number to chat WITH (the agent), not the user's own linked one.
        getAgentNumber(ac.signal)
          .then((r) => {
            if (!ac.signal.aborted) setAgentNumber(r.phoneNumber);
          })
          .catch(() => {
            // Non-fatal — the chat button just stays hidden until it resolves.
          });
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        router.replace("/onboarding");
      });
    return () => ac.abort();
  }, [session, isPending, router]);

  // ── Live sessions poll (only once the number is linked). ──────────────
  useEffect(() => {
    if (!phoneNumber) return;
    const ac = new AbortController();
    const load = () => {
      listSessions(ac.signal)
        .then((res) => {
          if (ac.signal.aborted) return;
          setSessions(res.sessions);
        })
        .catch(() => {
          // Transient — keep the last good list.
        });
    };
    load();
    const id = window.setInterval(load, SESSIONS_POLL_INTERVAL_MS);
    return () => {
      ac.abort();
      window.clearInterval(id);
    };
  }, [phoneNumber]);

  const liveSessions = (sessions ?? []).filter(
    (s) => s.state !== SessionState.ENDED,
  );
  const allAfkOn =
    liveSessions.length > 0 && liveSessions.every((s) => s.afk === AfkState.ON);

  // ── Account-wide AFK toggle. ──────────────────────────────────────────
  const onMasterAfk = useCallback(
    async (next: AfkState) => {
      if (afkBusy) return;
      setAfkBusy(true);
      // Optimistic: flip every live session locally.
      setSessions((prev) =>
        prev
          ? prev.map((s) =>
              s.state === SessionState.ENDED ? s : { ...s, afk: next },
            )
          : prev,
      );
      try {
        await setAfk(next);
      } catch (err) {
        toast.error(extractError(err, "Couldn't update AFK."));
      } finally {
        setAfkBusy(false);
      }
    },
    [afkBusy],
  );

  // ── Per-session AFK toggle. ───────────────────────────────────────────
  const onSessionAfk = useCallback(
    async (sessionId: string, next: AfkState) => {
      setSessions((prev) =>
        prev
          ? prev.map((s) => (s.id === sessionId ? { ...s, afk: next } : s))
          : prev,
      );
      try {
        await setAfk(next, sessionId);
      } catch (err) {
        toast.error(extractError(err, "Couldn't update AFK."));
      }
    },
    [],
  );

  const userEmail = session?.user?.email ?? null;

  if (isPending || !phoneNumber) {
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
        {/* Chat + linked number */}
        <section className="space-y-4">
          {agentNumber && (
            <a className="imsg-blue-btn" href={chatDeepLink(agentNumber)}>
              <MessageSquare aria-hidden="true" />
              Open chat in Messages
            </a>
          )}
          <div className="flex items-center justify-between rounded-lg border border-outline-variant/40 bg-surface-container-low px-4 py-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-outline">
                Linked number
              </div>
              <div className="mt-0.5 font-mono text-sm text-on-surface">
                {phoneNumber}
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-on-surface-variant">
              <span>AFK all sessions</span>
              <Switch
                checked={allAfkOn}
                onCheckedChange={(checked) =>
                  void onMasterAfk(checked ? AfkState.ON : AfkState.OFF)
                }
                disabled={afkBusy || liveSessions.length === 0}
                aria-label="Toggle away-from-keyboard for all sessions"
              />
            </label>
          </div>
        </section>

        {/* Sessions */}
        <section className="space-y-4">
          <div className="flex items-center justify-between border-b border-outline-variant/40 pb-2">
            <h2 className="text-lg font-bold tracking-tight">Sessions</h2>
            <span className="font-mono text-[10px] uppercase tracking-widest text-outline">
              {liveSessions.length} live
            </span>
          </div>

          {sessions === null ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : liveSessions.length === 0 ? (
            <div className="py-12 text-center text-sm text-outline">
              No live sessions. Pair a device from{" "}
              <a className="text-primary underline" href="/integrations">
                Integrations
              </a>
              , then start Claude Code.
            </div>
          ) : (
            <div className="space-y-3">
              {liveSessions.map((s) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  busy={afkBusy}
                  onToggleAfk={(next) => void onSessionAfk(s.id, next)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </DashboardChrome>
  );
}
