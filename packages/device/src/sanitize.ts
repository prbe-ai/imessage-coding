/**
 * @imsg/device — secret sanitization before egress.
 *
 * Everything this plugin sends to the cloud (attention-event descriptions,
 * input previews, the reply tool's text) passes through here first. The
 * spike shipped raw previews to localhost; productized, the previews leave the
 * machine, so we redact high-confidence secret shapes and cap length.
 *
 * This is best-effort defense-in-depth, NOT a guarantee — it complements the
 * server-side scrubbing. We err toward over-redaction of obvious credential
 * shapes; we do NOT attempt to parse arbitrary code.
 */

const REDACTED = '[redacted]';

/** Hard cap on any single previewed string leaving the device. */
export const MAX_PREVIEW_LEN = 2_000;

/**
 * High-confidence secret patterns. Order matters only for readability; each is
 * applied globally. Kept conservative to avoid mangling legitimate previews.
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // Provider API keys (Anthropic, OpenAI, GitHub, Slack, Stripe, Google, AWS).
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  // Bearer tokens in headers / curl.
  /\b[Bb]earer\s+[A-Za-z0-9._-]{12,}/g,
  // JWTs (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Private key blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * KEY=VALUE / "KEY": "VALUE" assignments where the key name screams secret.
 * Redacts only the VALUE, preserving the key so the preview stays legible.
 */
const ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*)\b(\s*[:=]\s*)(["']?)([^\s"',;]{4,})\3/gi;

/** Redact secrets from a single string and cap its length. */
export function sanitizeText(input: string): string {
  if (!input) return input;
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(ASSIGNMENT_PATTERN, (_m, key, sep, _q, _val) => `${key}${sep}${REDACTED}`);
  if (out.length > MAX_PREVIEW_LEN) out = out.slice(0, MAX_PREVIEW_LEN) + '…';
  return out;
}

/** Sanitize an optional preview field; passes through undefined. */
export function sanitizeOptional(input: string | undefined): string | undefined {
  return input === undefined ? undefined : sanitizeText(input);
}
