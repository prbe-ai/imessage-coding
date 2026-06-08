"use client";

/**
 * Sign-in page — Google-only.
 *
 * Flow:
 *   1. User lands here (unauthenticated, or bounced from the root router).
 *   2. "Continue with Google" → Better Auth (mounted at /api/idp) runs the
 *      Google OAuth round-trip, sets the session cookie, and bounces back to
 *      `callbackURL` (the root router, which then routes to /onboarding or
 *      /home based on whether a number is linked).
 *   3. An already-signed-in visitor is sent straight to the root router.
 *
 * UI: a single centered stack on the cream canvas — the product mark, a
 * tagline, then the Google button.
 */

import { Suspense, useEffect, useState, useSyncExternalStore } from "react";

import { authClient, signIn } from "@/lib/idp/better-auth-client";
import { Brand } from "@/components/icons";

/**
 * In-app browser (embedded WebView) detection.
 *
 * Google's OAuth refuses to run inside embedded WebViews: opening a link to the
 * dashboard from LinkedIn / Instagram / Facebook / etc. lands the visitor in
 * that app's in-app browser, and "Continue with Google" then dead-ends on
 * `Error 403: disallowed_useragent` (Google's "Use secure browsers" policy).
 * There is no way to bypass it — the page has to be reopened in a real browser.
 * We detect the WebView up front and show a handoff instead of a button that
 * cannot work.
 *
 * Heuristics: explicit in-app-browser UA tokens, plus the well-known
 * "iOS WebView drops the Safari token" signal — SFSafariViewController and the
 * real mobile browsers (incl. Chrome/CriOS, Firefox/FxiOS) keep `Safari` in the
 * UA; a bare WKWebView does not.
 */
const IN_APP_BROWSER_UA_RULES = [
  "LinkedInApp",
  "FBAN", // Facebook
  "FBAV", // Facebook
  "FB_IAB", // Facebook in-app browser
  "Instagram",
  "Twitter",
  "Line",
  "MicroMessenger", // WeChat
  "Snapchat",
  "TikTok",
  "musical_ly", // TikTok
  "Pinterest",
  "Android.*;\\s*wv\\)", // Android System WebView
  "(iPhone|iPod|iPad)(?!.*Safari)", // iOS WebView without the Safari token
];

const IN_APP_BROWSER_RE = new RegExp(
  `(${IN_APP_BROWSER_UA_RULES.join("|")})`,
  "i",
);

function isInAppBrowser(): boolean {
  if (typeof navigator === "undefined" || !navigator.userAgent) return false;
  return IN_APP_BROWSER_RE.test(navigator.userAgent);
}

type Platform = "ios" | "android" | "other";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

/** Per-platform hint for escaping the in-app browser to the real one. */
const ESCAPE_HINT: Record<Platform, string> = {
  ios: 'Tap the ••• menu in the top corner, then "Open in Safari" (or your browser).',
  android: 'Tap the ⋮ menu in the top corner, then "Open in browser".',
  other: "Open this page in your default web browser to continue.",
};

const NOOP_SUBSCRIBE = () => () => {};

/**
 * True only once mounted on the client. WebView detection reads `navigator`,
 * which doesn't exist during SSR — gating on this renders the SSR-safe (normal
 * button) branch during hydration, then switches to the detected branch after,
 * which `useSyncExternalStore` does without a hydration mismatch.
 */
function useHasHydrated(): boolean {
  return useSyncExternalStore(
    NOOP_SUBSCRIBE,
    () => true,
    () => false,
  );
}

function SignInInner() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const hydrated = useHasHydrated();
  const inAppBrowser = hydrated && isInAppBrowser();
  const platform: Platform = hydrated ? detectPlatform() : "other";

  useEffect(() => {
    authClient
      .getSession()
      .then(({ data }) => {
        if (data?.session) {
          window.location.replace(`${window.location.origin}/`);
        }
      })
      .catch((err) => {
        console.error("[auth/sign-in] getSession threw", err);
      });
  }, []);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked in some WebViews — the manual menu hint above
      // still gets the user there, so swallow rather than surface an error.
    }
  }

  async function signInWithGoogle() {
    setLoading(true);
    setError(null);
    try {
      await signIn.social({
        provider: "google",
        callbackURL: `${window.location.origin}/`,
      });
      // signIn.social resolves a microtask before the redirect unloads the
      // page, so reaching here on the happy path is normal — keep the loading
      // state so a silent failure stays visible.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setLoading(false);
    }
  }

  return (
    <div className="signin-page">
      <div className="signin-stack">
        <Brand className="signin-brand" />
        <div className="signin-options">
          <h1 className="signin-options-title">Sign in</h1>
          <p className="signin-tagline">
            Steer your Claude Code and Codex sessions from iMessage.
          </p>
          {inAppBrowser ? (
            <div className="signin-inapp">
              <p className="signin-inapp-lead">
                Google won&apos;t let you sign in from inside another app&apos;s
                browser. Reopen this page in your browser to continue.
              </p>
              <p className="signin-inapp-hint">{ESCAPE_HINT[platform]}</p>
              <button
                type="button"
                className="signin-google-btn"
                onClick={copyLink}
              >
                {copied ? "Link copied ✓" : "Copy link"}
              </button>
              <button
                type="button"
                className="signin-inapp-fallback"
                onClick={signInWithGoogle}
                disabled={loading}
              >
                {loading ? "Redirecting…" : "Continue with Google anyway"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="signin-google-btn"
              onClick={signInWithGoogle}
              disabled={loading}
            >
              <svg
                viewBox="0 0 18 18"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  fill="#4285F4"
                  d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
                />
                <path
                  fill="#34A853"
                  d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
                />
                <path
                  fill="#FBBC05"
                  d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
                />
                <path
                  fill="#EA4335"
                  d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
                />
              </svg>
              {loading ? "Redirecting…" : "Continue with Google"}
            </button>
          )}
          {error && <p className="signin-options-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInInner />
    </Suspense>
  );
}
