/**
 * @imsg/device — HTTP client + classification + backoff.
 *
 * Ports prbe-cc-tap-plugin/tap/httpclient.py: a Classify enum
 * (Success / Poison / Halt / Retry) and exponential backoff with jitter,
 * capped at 300s. Uses the runtime `fetch` (Bun/Node 18+); zero extra deps.
 *
 * Classification drives the outbox + long-poll logic:
 *   SUCCESS  2xx               → done
 *   HALT     401               → device token revoked; clear creds, stop egress
 *   POISON   400 | 403 | 404   → unrecoverable for this payload; drop it
 *   RETRY    network err | 5xx → back off and retry
 */

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 5 * 60 * 1_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export const Classification = {
  SUCCESS: 'success',
  POISON: 'poison',
  HALT: 'halt',
  RETRY: 'retry',
} as const;
export type Classification = (typeof Classification)[keyof typeof Classification];

export interface HttpResponse {
  status: number;
  body: string;
  classification: Classification;
  error: string;
}

export function classify(status: number, networkError: boolean): Classification {
  if (networkError) return Classification.RETRY;
  if (status >= 200 && status < 300) return Classification.SUCCESS;
  if (status === 401) return Classification.HALT;
  if (status === 400 || status === 403 || status === 404) return Classification.POISON;
  return Classification.RETRY;
}

/** min(2^attempt * 1s, 5min) + jitter ∈ [0, 1s). */
export function backoffMs(attempt: number): number {
  const a = attempt < 0 ? 0 : attempt;
  let exp: number;
  if (a > 30) {
    exp = BACKOFF_CAP_MS;
  } else {
    exp = BACKOFF_BASE_MS * (1 << a);
    if (exp > BACKOFF_CAP_MS) exp = BACKOFF_CAP_MS;
  }
  return exp + Math.floor(Math.random() * BACKOFF_BASE_MS);
}

function traceId(): string {
  // 16 random bytes hex — matches tap-plugin's X-Trace-Id shape.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface RequestOpts {
  bearer?: string | null;
  timeoutMs?: number;
  /** Caller-supplied signal (long-poll cancellation); composed with the timeout. */
  signal?: AbortSignal;
}

async function request(
  method: 'GET' | 'POST',
  url: string,
  body: string | null,
  opts: RequestOpts,
): Promise<HttpResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const headers: Record<string, string> = {
    'User-Agent': 'imsg-device/0.1.0',
    'X-Trace-Id': traceId(),
  };
  if (body !== null) headers['Content-Type'] = 'application/json';
  if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      signal: controller.signal,
    });
    const text = await resp.text().catch(() => '');
    return {
      status: resp.status,
      body: text,
      classification: classify(resp.status, false),
      error: '',
    };
  } catch (err) {
    return {
      status: 0,
      body: '',
      classification: Classification.RETRY,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function postJson(url: string, body: string, opts: RequestOpts = {}): Promise<HttpResponse> {
  return request('POST', url, body, opts);
}

export function getJson(url: string, opts: RequestOpts = {}): Promise<HttpResponse> {
  return request('GET', url, null, opts);
}

export function parseJson<T = Record<string, unknown>>(resp: HttpResponse): T | null {
  if (!resp.body) return null;
  try {
    return JSON.parse(resp.body) as T;
  } catch {
    return null;
  }
}
