"use client";

/**
 * Onboarding wizard.
 *
 * State machine (linear, with a poll loop):
 *   boot      → resolve session; bounce to /sign-in if none, /home if already
 *               verified. Otherwise mint a token and show the deep link.
 *   link      → "Welcome <name>" + prefilled iMessage deep-link button
 *               (`sms:&body=hey! this is <token>`). After the user taps it we
 *               poll /api/onboarding/status for the orchestrator to match the
 *               texted-in token and derive their number.
 *   confirm   → derived number shown; one-tap "That's me" → POST confirm.
 *   done      → number verified → /home.
 *
 * The single-use token is minted server-side (POST /api/onboarding/start),
 * >=128-bit, short-TTL, and bound to the Better Auth session id.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare, PhoneCall } from "lucide-react";

import { useSession } from "@/lib/idp/better-auth-client";
import { AccountMenu } from "@/components/account-menu";
import {
  OnboardingShell,
  StepVisual,
  LoadingPane,
} from "@/components/onboarding-shell";
import {
  startOnboarding,
  getOnboardingStatus,
  confirmNumber,
} from "@/lib/api/onboarding";
import { smsDeepLink } from "@/lib/deep-link";
import { extractError } from "@/lib/utils";

/** How often to poll for an inbound match once the deep link is shown. */
const STATUS_POLL_INTERVAL_MS = 2500;

type Step = "boot" | "link" | "confirm" | "done" | "error";

export default function OnboardingPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  const [step, setStep] = useState<Step>("boot");
  const [token, setToken] = useState<string | null>(null);
  // The agent number to text, returned by /api/onboarding/start (per-account).
  const [agentNumber, setAgentNumber] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const bootStartedRef = useRef(false);

  const firstName = (() => {
    const name = session?.user?.name?.trim();
    if (name) return name.split(/\s+/)[0];
    const email = session?.user?.email ?? "";
    return email.split("@")[0] || "there";
  })();

  // ── Boot: resolve where the user belongs and mint a token. ────────────
  useEffect(() => {
    if (bootStartedRef.current) return;
    if (isPending) return;
    if (!session) {
      router.replace("/sign-in");
      return;
    }
    bootStartedRef.current = true;

    const ac = new AbortController();
    (async () => {
      try {
        const status = await getOnboardingStatus(ac.signal);
        if (ac.signal.aborted) return;
        if (status.verified) {
          router.replace("/home");
          return;
        }
        if (status.matched && status.phoneNumber) {
          setPhoneNumber(status.phoneNumber);
          setStep("confirm");
          return;
        }
        // Fresh: mint the single-use onboarding token for the deep link.
        const minted = await startOnboarding(ac.signal);
        if (ac.signal.aborted) return;
        setToken(minted.token);
        setAgentNumber(minted.agentNumber);
        setStep("link");
      } catch (err) {
        if (ac.signal.aborted) return;
        bootStartedRef.current = false;
        setErrorMsg(
          extractError(err, "We couldn't start onboarding. Please refresh."),
        );
        setStep("error");
      }
    })();

    return () => ac.abort();
  }, [session, isPending, router]);

  // ── Poll for the inbound match once the deep link is shown. ───────────
  useEffect(() => {
    if (step !== "link") return;
    const ac = new AbortController();
    const id = window.setInterval(() => {
      getOnboardingStatus(ac.signal)
        .then((status) => {
          if (ac.signal.aborted) return;
          if (status.verified) {
            router.replace("/home");
            return;
          }
          if (status.matched && status.phoneNumber) {
            setPhoneNumber(status.phoneNumber);
            setStep("confirm");
          }
        })
        .catch(() => {
          // Transient — keep polling.
        });
    }, STATUS_POLL_INTERVAL_MS);
    return () => {
      ac.abort();
      window.clearInterval(id);
    };
  }, [step, router]);

  const onConfirm = useCallback(async () => {
    if (confirming) return;
    setConfirming(true);
    setErrorMsg(null);
    try {
      const res = await confirmNumber();
      if (res.verified) {
        setStep("done");
        // Hard navigation so the home page reads the fresh state cleanly.
        window.location.replace("/home");
        return;
      }
      setErrorMsg("Confirmation didn't take — please try again.");
    } catch (err) {
      setErrorMsg(
        extractError(err, "We couldn't confirm your number. Please try again."),
      );
    } finally {
      setConfirming(false);
    }
  }, [confirming]);

  const userEmail = session?.user?.email ?? null;
  const userBadge = <AccountMenu email={userEmail} />;

  if (step === "boot") {
    return (
      <LoadingPane
        stepKey="onb-boot"
        rightTop={userBadge}
        leftVisual={<StepVisual icon={<MessageSquare />} title="Welcome" />}
        message="Setting things up…"
      />
    );
  }

  if (step === "error") {
    return (
      <OnboardingShell
        stepKey="onb-error"
        rightTop={userBadge}
        leftVisual={<StepVisual icon={<MessageSquare />} title="Hmm" />}
        footer={
          <button
            type="button"
            className="onb-btn onb-btn-secondary"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        }
      >
        <p className="onb-signup-error">{errorMsg}</p>
      </OnboardingShell>
    );
  }

  // ── Step: link your number (deep link). ───────────────────────────────
  if (step === "link" && token) {
    const href = smsDeepLink(token, agentNumber);
    return (
      <OnboardingShell
        stepKey="onb-link"
        rightTop={userBadge}
        leftVisual={
          <StepVisual icon={<MessageSquare />} title={`Welcome, ${firstName}`} />
        }
        footer={
          <a className="imsg-blue-btn" href={href}>
            <MessageSquare aria-hidden="true" />
            Start texting
          </a>
        }
      >
        <p className="onb-confirm-body">
          Link your phone so you can steer Claude Code from iMessage. Tap the
          button below — it opens Messages with a one-time code prefilled. Just
          hit send, and we&apos;ll link your number automatically.
        </p>
        <div className="onb-cmd" aria-label="Prefilled message">
          <p className="onb-cmd-text">hey! this is {token}</p>
        </div>
        <p className="onb-fineprint">
          Waiting for your message… this page updates on its own once it lands.
        </p>
      </OnboardingShell>
    );
  }

  // ── Step: confirm derived number. ─────────────────────────────────────
  if (step === "confirm") {
    return (
      <OnboardingShell
        stepKey="onb-confirm"
        rightTop={userBadge}
        leftVisual={<StepVisual icon={<PhoneCall />} title="Confirm your number" />}
        footer={
          <button
            type="button"
            className="onb-btn onb-btn-primary"
            onClick={() => void onConfirm()}
            disabled={confirming}
          >
            {confirming ? "Confirming…" : "That's me — confirm"}
            <span style={{ marginLeft: 2 }}>→</span>
          </button>
        }
      >
        <p className="onb-confirm-body">
          We matched your message to this number. Confirm it&apos;s yours to
          finish linking.
        </p>
        <div className="onb-callout onb-callout--ok">
          <p className="onb-callout-title">{phoneNumber}</p>
          <p className="onb-callout-body">
            Messages from this number will steer your Claude Code sessions.
          </p>
        </div>
        {errorMsg && <p className="onb-signup-error">{errorMsg}</p>}
      </OnboardingShell>
    );
  }

  return (
    <LoadingPane
      stepKey="onb-done"
      rightTop={userBadge}
      leftVisual={<StepVisual icon={<MessageSquare />} title="All set" />}
      message="Taking you to your dashboard…"
    />
  );
}
