/**
 * iMessage / SMS deep-link builders.
 *
 * Onboarding deep link: opens Messages composed to the product's agent number
 * (when known) with a prefilled body carrying the single-use onboarding token,
 * so the user just taps Send. The token lets the webhook orchestrator match
 * the inbound message back to the right account and derive the sender's number.
 *
 * Format note: the `sms:` scheme's body param is the broadly-supported way to
 * prefill a message on iOS. When the agent number is known we target it
 * (`sms:+1...&body=...`); otherwise we fall back to a recipient-less compose
 * (`sms:&body=...`) per the contract.
 */

/** The phrase prefixing the onboarding token in the prefilled message body. */
export const ONBOARDING_GREETING = "hey! this is" as const;

/** Build the prefilled message body for the onboarding deep link. */
export function onboardingBody(token: string): string {
  return `${ONBOARDING_GREETING} ${token}`;
}

/** Build the `sms:` deep link. `to` is the agent's E.164 number, or null for a
 *  recipient-less compose. */
export function smsDeepLink(token: string, to: string | null): string {
  const body = encodeURIComponent(onboardingBody(token));
  const recipient = to ? encodeURIComponent(to) : "";
  return `sms:${recipient}&body=${body}`;
}

/** Build a plain chat deep link (no prefilled body) to the agent number — the
 *  Home page's "open chat" CTA. */
export function chatDeepLink(to: string): string {
  return `sms:${encodeURIComponent(to)}`;
}
