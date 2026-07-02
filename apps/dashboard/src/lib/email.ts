/**
 * Minimal transactional email via Resend (https://resend.com), used to notify
 * an operator when a new user requests access on the invite gate. Talks to the
 * Resend REST API directly (no SDK dependency).
 *
 * Config (env):
 *   RESEND_API_KEY       — required to actually send; if unset we SKIP (no-op,
 *                          returns false) so the dashboard runs in dev without it.
 *   RESEND_FROM          — the "from" address (default onboarding@resend.dev,
 *                          which Resend allows without a verified domain for
 *                          testing; set a verified prbe.ai sender in prod).
 *   SIGNUP_NOTIFY_EMAIL  — where the notification goes (default richard@prbe.ai).
 *
 * Server-only.
 */
import "server-only";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "onboarding@resend.dev";
const DEFAULT_NOTIFY = "richard@prbe.ai";

/**
 * Email the operator that a new user requested access, with the email + phone
 * they'll need to add to Sendblue. Best-effort: never throws (the caller must
 * not fail the user's request on an email hiccup) and returns whether it sent.
 */
export async function notifyOperatorOfAccessRequest(args: {
  email: string;
  phone: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[email] RESEND_API_KEY unset — skipping access-request notification",
    );
    return false;
  }
  const from = process.env.RESEND_FROM || DEFAULT_FROM;
  const to = process.env.SIGNUP_NOTIFY_EMAIL || DEFAULT_NOTIFY;

  const text =
    `New imessage-coding access request:\n\n` +
    `Email: ${args.email}\n` +
    `Phone: ${args.phone}\n\n` +
    `To approve: add this number to Sendblue (sendblue add-contact ${args.phone}), ` +
    `then set accounts.access_status = 'approved' for ${args.email}.`;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `New access request: ${args.email}`,
        text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(
        `[email] Resend send failed: ${res.status} ${res.statusText} ${detail}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] Resend send threw", err);
    return false;
  }
}
