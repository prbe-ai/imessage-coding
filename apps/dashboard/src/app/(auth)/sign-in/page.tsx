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

import { Suspense, useEffect, useState } from "react";

import { authClient, signIn } from "@/lib/idp/better-auth-client";
import { Brand } from "@/components/icons";

function SignInInner() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
