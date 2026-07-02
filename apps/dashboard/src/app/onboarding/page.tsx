"use client";

/**
 * Onboarding wizard.
 *
 * State machine (linear, with a poll loop):
 *   boot      → resolve session; bounce to /sign-in if none, /home if already
 *               onboarded (number verified). Otherwise mint a token → link.
 *   link      → "Welcome <name>" + prefilled iMessage deep-link button
 *               (`sms:&body=hey! this is <token>`). After the user taps it we
 *               poll /api/onboarding/status. The orchestrator binds AND verifies
 *               the number the instant it matches the token, so the poll sees
 *               `verified` and advances straight to the in-flow pair step.
 *   confirm   → derived number shown; one-tap "That's me" → POST confirm.
 *               Fallback only — unreachable while the orchestrator auto-verifies
 *               on match (a matched conversation is always already verified).
 *   install   → pair the first device (shared install UI) → "Next" → /home.
 *               The in-flow last step of onboarding; reached from link/confirm,
 *               never from a returning visitor (boot/root send those to /home).
 *   done      → leaving for /home.
 *
 * The single-use token is minted server-side (POST /api/onboarding/start),
 * >=128-bit, short-TTL, and bound to the Better Auth session id.
 */

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  Clock,
  Copy,
  MessageSquare,
  PhoneCall,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";

import { AccessStatus } from "@imsg/shared";

import { useSession } from "@/lib/idp/better-auth-client";
import { AccountMenu } from "@/components/account-menu";
import { PairDeviceCard } from "@/components/pair-device-card";
import { UsageSteps } from "@/components/usage-steps";
import {
  OnboardingShell,
  StepVisual,
  LoadingPane,
} from "@/components/onboarding-shell";
import {
  startOnboarding,
  getOnboardingStatus,
  confirmNumber,
  requestAccess,
} from "@/lib/api/onboarding";
import { onboardingBody, smsDeepLink } from "@/lib/deep-link";
import { extractError } from "@/lib/utils";

/** How often to poll for an inbound match once the deep link is shown. */
const STATUS_POLL_INTERVAL_MS = 2500;

type Step =
  | "boot"
  | "gate"
  | "requested"
  | "link"
  | "confirm"
  | "install"
  | "done"
  | "error";

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
  // Invite gate (pending accounts): the phone the user submits for review.
  const [gatePhone, setGatePhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Whether the agent number was just copied (drives the ✓ affordance).
  const [copied, setCopied] = useState(false);
  // "Not on a Mac?" disclosure — collapsed until the user opens it.
  const [notOnMacOpen, setNotOnMacOpen] = useState(false);

  const bootStartedRef = useRef(false);
  const copyResetRef = useRef<number | null>(null);

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
        // Invite gate: a pending account can't self-onboard yet (Sendblue's
        // free tier caps verified contacts). Show the phone-input gate, or the
        // waitlist page if they've already submitted — never mint a token or
        // require an agent number for them.
        if (status.accessStatus !== AccessStatus.APPROVED) {
          setStep(status.accessRequested ? "requested" : "gate");
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
          // The orchestrator binds AND verifies the number the moment it
          // matches the texted-in token (conversations.verified_at = now()), so
          // the conversation is already `verified` here — there's no
          // matched-but-unverified window. Since this poll only runs while the
          // user is actively on the `link` step, advance them to the in-flow
          // pair step rather than bouncing to /home (which `boot` reserves for
          // already-onboarded visitors). `confirm` stays as a fallback for the
          // (currently unreachable) matched-without-verified case.
          if (status.verified) {
            setStep("install");
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
        // Number linked — nudge the user to pair their first device before
        // dropping them on Home (they can still skip via "Next").
        setStep("install");
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

  // ── Invite gate: submit the requested phone for operator review. ──────
  const onRequestAccess = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (submitting) return;
      setSubmitting(true);
      setErrorMsg(null);
      try {
        await requestAccess(gatePhone);
        setStep("requested");
      } catch (err) {
        setErrorMsg(
          extractError(
            err,
            "We couldn't submit that — check the number and try again.",
          ),
        );
      } finally {
        setSubmitting(false);
      }
    },
    [gatePhone, submitting],
  );

  // Copy the agent number for people who can't open Messages on this device —
  // e.g. they're on a non-Mac and will text from a phone instead.
  const copyNumber = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Copied number");
      if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select and copy manually.");
    }
  }, []);

  // Clear any pending copy-reset timer on unmount.
  useEffect(
    () => () => {
      if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
    },
    [],
  );

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

  // ── Step: invite gate — collect the phone for operator review. ────────
  if (step === "gate") {
    return (
      <OnboardingShell
        stepKey="onb-gate"
        rightTop={userBadge}
        leftVisual={
          <StepVisual icon={<MessageSquare />} title={`Hey ${firstName} 👋`} />
        }
        footer={
          <button
            type="submit"
            form="onb-gate-form"
            className="onb-btn onb-btn-primary"
            disabled={submitting}
          >
            {submitting ? "Sending…" : "Request access"}
            <span style={{ marginLeft: 2 }}>→</span>
          </button>
        }
      >
        <p className="onb-confirm-body">
          imessage-coding lets you steer Claude Code and Codex from iMessage. Drop
          your number and I&apos;ll reach out to get you set up.
        </p>
        <form id="onb-gate-form" className="onb-form" onSubmit={onRequestAccess}>
          <div className="onb-field">
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+1 555 123 4567"
              value={gatePhone}
              onChange={(e) => setGatePhone(e.target.value)}
              disabled={submitting}
              aria-label="Your phone number"
              required
            />
          </div>
        </form>
        {errorMsg && <p className="onb-signup-error">{errorMsg}</p>}
      </OnboardingShell>
    );
  }

  // ── Step: waitlist — request received, operator will follow up. ───────
  if (step === "requested") {
    return (
      <OnboardingShell
        stepKey="onb-requested"
        rightTop={userBadge}
        leftVisual={<StepVisual icon={<Clock />} title="You're on the list" />}
      >
        <p className="onb-confirm-body">
          Thanks! Space is limited and it&apos;s a bit costly to keep this
          running for free, so I&apos;m onboarding people by hand right now.
          I&apos;ll reach out to {userEmail ?? "your email"} as soon as
          there&apos;s room — hang tight.
        </p>
      </OnboardingShell>
    );
  }

  // ── Step: link your number (deep link). ───────────────────────────────
  if (step === "link" && token) {
    const href = smsDeepLink(token, agentNumber, firstName);
    const messageBody = onboardingBody(token, firstName);
    return (
      <OnboardingShell
        stepKey="onb-link"
        rightTop={userBadge}
        leftVisual={
          <StepVisual icon={<MessageSquare />} title={`Welcome, ${firstName}`} />
        }
      >
        <p className="onb-confirm-body">
          Link your phone so you can steer Claude Code and Codex from iMessage. Tap the
          button below — it opens Messages with a one-time code prefilled. Just
          hit send, and we&apos;ll link your number automatically.
        </p>
        <div className="onb-cmd" aria-label="Prefilled message">
          <p className="onb-cmd-text">{messageBody}</p>
        </div>
        <a className="imsg-blue-btn" href={href}>
          <MessageSquare aria-hidden="true" />
          Start texting
        </a>
        {agentNumber && (
          <div className="onb-disclosure">
            <button
              type="button"
              className="onb-disclosure-trigger"
              aria-expanded={notOnMacOpen}
              aria-controls="onb-not-on-mac"
              onClick={() => setNotOnMacOpen((open) => !open)}
            >
              Not on a Mac?
              <ChevronDown aria-hidden="true" />
            </button>
            {notOnMacOpen && (
              <div className="onb-disclosure-panel" id="onb-not-on-mac">
                <p className="onb-disclosure-text">
                  Text the message to this number from any phone:{" "}
                  <button
                    type="button"
                    className={`onb-inline-copy${copied ? " onb-inline-copy--done" : ""}`}
                    onClick={() => void copyNumber(agentNumber)}
                    aria-label={`Copy number ${agentNumber}`}
                  >
                    {agentNumber}
                    {copied ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <Copy aria-hidden="true" />
                    )}
                  </button>
                </p>
              </div>
            )}
          </div>
        )}
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
            Messages from this number will steer your Claude Code and Codex sessions.
          </p>
        </div>
        {errorMsg && <p className="onb-signup-error">{errorMsg}</p>}
      </OnboardingShell>
    );
  }

  // ── Step: install the script on the first device. ─────────────────────
  if (step === "install") {
    return (
      <OnboardingShell
        stepKey="onb-install"
        rightTop={userBadge}
        rightWide
        leftVisual={<StepVisual icon={<Terminal />} title="Pair your first device" />}
        footer={
          <button
            type="button"
            className="onb-btn onb-btn-primary"
            // Hard navigation so Home reads the freshly verified state cleanly.
            onClick={() => window.location.replace("/home")}
          >
            Next
            <span style={{ marginLeft: 2 }}>→</span>
          </button>
        }
      >
        <p className="onb-confirm-body">
          Last step — run this one-liner on the machine where you use Claude Code
          or Codex. It installs the Probe plugin and links the device to your
          account. You can always pair more devices later from Integrations.
        </p>
        <PairDeviceCard />
        <UsageSteps />
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
