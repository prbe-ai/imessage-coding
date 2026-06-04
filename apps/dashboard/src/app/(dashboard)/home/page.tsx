"use client";

/**
 * Home page.
 *
 * - iMessage "Chat" deep-link button (opens Messages to the agent number).
 * - The linked, verified phone number.
 * - An account-wide AFK master toggle (sets AFK across every live session).
 * - A live Sessions list (per device/agent): an initial snapshot from the
 *   dashboard's own /api/home/sessions, then a live EventSource to the control
 *   plane's /api/dashboard/events (the SSE hub + source of truth), so a
 *   dashboard/CLI AFK toggle reflects here within ~1s with no polling.
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
import { DeviceCard } from "@/components/device-card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AfkState,
  SessionState,
  SseEvent,
  type DeviceInfo,
  type SessionInfo,
} from "@imsg/shared";
import {
  getAgentNumber,
  getLinkedNumber,
  getSseTicket,
  listDevices,
  listSessions,
  setAfk,
} from "@/lib/api/home";
import { chatDeepLink } from "@/lib/deep-link";
import { extractError } from "@/lib/utils";

export default function HomePage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  // The agent number to chat WITH (distinct from phoneNumber, the user's own).
  const [agentNumber, setAgentNumber] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  // Devices carry the machine-wide afk; sessions nest under them.
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
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

  // ── Live sessions via the control-plane SSE hub (once the number is linked).
  //    Initial snapshot from the same-origin route, then a live EventSource to
  //    the control plane; on drop we re-mint a ticket and reconnect (bounded
  //    backoff). The control plane is the source of truth — a dashboard/CLI AFK
  //    toggle round-trips back here as a fresh `sessions` event. ──────────────
  useEffect(() => {
    if (!phoneNumber) return;
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: number | undefined;
    let attempt = 0;

    // First paint from the same-origin snapshot; the stream then drives updates.
    const ac = new AbortController();
    listSessions(ac.signal)
      .then((res) => {
        if (!cancelled) setSessions(res.sessions);
      })
      .catch(() => {
        // Transient — keep the last good list.
      });
    listDevices(ac.signal)
      .then((res) => {
        if (!cancelled) setDevices(res.devices);
      })
      .catch(() => {
        // Transient — keep the last good list.
      });

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      attempt += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      reconnectTimer = window.setTimeout(() => void connect(), delay);
    };

    const connect = async () => {
      if (cancelled) return;
      try {
        const { ticket, url } = await getSseTicket(ac.signal);
        if (cancelled) return;
        const sep = url.includes("?") ? "&" : "?";
        const source = new EventSource(
          `${url}${sep}ticket=${encodeURIComponent(ticket)}`,
        );
        es = source;
        source.addEventListener("open", () => {
          attempt = 0; // healthy connection → reset backoff
        });
        source.addEventListener(SseEvent.SESSIONS, (ev) => {
          try {
            const body = JSON.parse((ev as MessageEvent).data) as {
              sessions: SessionInfo[];
            };
            if (!cancelled) setSessions(body.sessions);
          } catch {
            // Ignore a malformed frame; the next event reconciles.
          }
        });
        source.addEventListener(SseEvent.DEVICES, (ev) => {
          try {
            const body = JSON.parse((ev as MessageEvent).data) as {
              devices: DeviceInfo[];
            };
            if (!cancelled) setDevices(body.devices);
          } catch {
            // Ignore a malformed frame; the next event reconciles.
          }
        });
        source.addEventListener("error", () => {
          // On a transient drop the browser auto-reconnects (readyState
          // CONNECTING) reusing this ticket — let it; that's a ~3s recovery vs.
          // our backoff. Only take over on a permanent close (CLOSED) — e.g. the
          // ticket expired and the retry 401'd — by re-minting a fresh ticket.
          if (source.readyState !== EventSource.CLOSED) return;
          if (es === source) es = null;
          scheduleReconnect();
        });
      } catch {
        // Ticket mint failed (e.g. SSE not yet configured) — back off + retry.
        scheduleReconnect();
      }
    };

    void connect();

    return () => {
      cancelled = true;
      ac.abort();
      es?.close();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    };
  }, [phoneNumber]);

  const liveSessions = (sessions ?? []).filter(
    (s) => s.state !== SessionState.ENDED,
  );
  const liveDevices = devices ?? [];
  // AFK is machine-wide → "all on" means every device is AFK.
  const allAfkOn =
    liveDevices.length > 0 && liveDevices.every((d) => d.afk === AfkState.ON);
  // Group this device's live sessions for nesting under its card.
  const sessionsForDevice = useCallback(
    (deviceId: string) => liveSessions.filter((s) => s.deviceId === deviceId),
    [liveSessions],
  );

  // ── Master AFK toggle (every device). ─────────────────────────────────
  const onMasterAfk = useCallback(
    async (next: AfkState) => {
      if (afkBusy) return;
      setAfkBusy(true);
      // Optimistic: flip every device locally; snapshot for rollback on failure.
      let prevDevices: DeviceInfo[] | null = null;
      setDevices((prev) => {
        prevDevices = prev;
        return prev ? prev.map((d) => ({ ...d, afk: next })) : prev;
      });
      try {
        await setAfk(next);
      } catch (err) {
        setDevices(prevDevices);
        toast.error(extractError(err, "Couldn't update AFK."));
      } finally {
        setAfkBusy(false);
      }
    },
    [afkBusy],
  );

  // ── Per-device AFK toggle (machine-wide). ─────────────────────────────
  const onDeviceAfk = useCallback(
    async (deviceId: string, next: AfkState) => {
      if (afkBusy) return;
      setAfkBusy(true);
      // Optimistic flip; remember the prior value to roll back on failure.
      let prevAfk: AfkState | undefined;
      setDevices((prev) =>
        prev
          ? prev.map((d) => {
              if (d.id !== deviceId) return d;
              prevAfk = d.afk;
              return { ...d, afk: next };
            })
          : prev,
      );
      try {
        const res = await setAfk(next, deviceId);
        // updated === 0 means no device matched (revoked between render and
        // click) — the write never took, so treat it as a failure.
        if (res.updated === 0) throw new Error("Device is no longer available.");
      } catch (err) {
        if (prevAfk !== undefined) {
          const restore = prevAfk;
          setDevices((prev) =>
            prev
              ? prev.map((d) => (d.id === deviceId ? { ...d, afk: restore } : d))
              : prev,
          );
        }
        toast.error(extractError(err, "Couldn't update AFK."));
      } finally {
        setAfkBusy(false);
      }
    },
    [afkBusy],
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
              <div className="text-xs tracking-tight text-outline">
                Linked number
              </div>
              <div className="mt-0.5 font-mono text-sm text-on-surface">
                {phoneNumber}
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-on-surface-variant">
              <span>AFK all devices</span>
              <Switch
                checked={allAfkOn}
                onCheckedChange={(checked) =>
                  void onMasterAfk(checked ? AfkState.ON : AfkState.OFF)
                }
                disabled={afkBusy || liveDevices.length === 0}
                aria-label="Toggle away-from-keyboard for all devices"
              />
            </label>
          </div>
        </section>

        {/* Devices (AFK lives here, machine-wide) → sessions nest under each. */}
        <section className="space-y-4">
          <div className="flex items-center justify-between border-b border-outline-variant/40 pb-2">
            <h2 className="text-lg font-bold tracking-tight">Devices</h2>
            <span className="text-xs tracking-tight text-outline">
              {liveDevices.length} paired · {liveSessions.length} live
            </span>
          </div>

          {devices === null ? (
            <div className="space-y-3">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          ) : liveDevices.length === 0 ? (
            <div className="py-12 text-center text-sm text-outline">
              No active devices. Start Claude Code or Codex on a paired machine, or pair
              one from{" "}
              <a className="text-primary underline" href="/integrations">
                Integrations
              </a>
              .
            </div>
          ) : (
            <div className="space-y-4">
              {liveDevices.map((d) => (
                <DeviceCard
                  key={d.id}
                  device={d}
                  sessions={sessionsForDevice(d.id)}
                  afkBusy={afkBusy}
                  onToggleAfk={(next) => void onDeviceAfk(d.id, next)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </DashboardChrome>
  );
}
