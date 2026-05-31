/**
 * Device authentication.
 *
 * A device authenticates with a Bearer device_token. We NEVER store the raw
 * token; the DB holds a peppered SHA-256 hash (devices.device_token_hash). The
 * raw token is returned exactly once at pair time.
 *
 * The pepper is a server-side secret (DEVICE_TOKEN_PEPPER) that is mixed into
 * the hash so a database leak alone cannot be used to forge tokens.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { loadEnv } from '../env.ts';
import { findDeviceByTokenHash } from '../db/repo.ts';

/** Bytes of entropy in a freshly minted device token (256-bit). */
const DEVICE_TOKEN_BYTES = 32;

/** Authenticated device identity, attached to the request context. */
export interface DeviceAuth {
  deviceId: string;
  accountId: string;
}

/** Hono context variable key for the authenticated device. */
export const DEVICE_CTX_KEY = 'device' as const;

/** Typed Hono env so `c.get(DEVICE_CTX_KEY)` is `DeviceAuth`. */
export interface DeviceHonoEnv {
  Variables: { [DEVICE_CTX_KEY]: DeviceAuth };
}

/** Generate a new, URL-safe device token (raw — returned to the device once). */
export function generateDeviceToken(): string {
  return randomBytes(DEVICE_TOKEN_BYTES).toString('base64url');
}

/**
 * Peppered hash of a token. Used for BOTH device tokens and pairing/onboarding
 * tokens so a leaked DB row cannot be reversed into a usable token.
 */
export function hashToken(rawToken: string): string {
  const { deviceTokenPepper } = loadEnv();
  return createHmac('sha256', deviceTokenPepper).update(rawToken).digest('hex');
}

/** Constant-time hex-string comparison. */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract a Bearer token from the Authorization header, if present. */
function bearerFromContext(c: Context): string | undefined {
  const header = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Middleware: require a valid Bearer device_token. On success it attaches the
 * resolved { deviceId, accountId } to the context. On failure it returns 401
 * and never proceeds (fail-closed).
 */
export const requireDevice: MiddlewareHandler<DeviceHonoEnv> = async (c, next) => {
  const raw = bearerFromContext(c);
  if (!raw) {
    return c.json({ error: 'missing_bearer_token' }, 401);
  }
  const auth = await findDeviceByTokenHash(hashToken(raw));
  if (!auth) {
    return c.json({ error: 'invalid_device_token' }, 401);
  }
  c.set(DEVICE_CTX_KEY, auth);
  await next();
  return undefined;
};
