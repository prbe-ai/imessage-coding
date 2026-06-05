/**
 * Inbound image fetching for the orchestrator turn engine.
 *
 * AgentPhone delivers MMS / iMessage photos as `mediaUrl`(s) on the webhook (see
 * @imsg/transport parseInbound). To put them in front of the model we FETCH the
 * bytes here and inline them as base64 `data:` URIs rather than handing the raw
 * provider URL to the LLM. That choice is deliberate:
 *   - The provider URL may require the AgentPhone API key OR be a short-lived
 *     presigned link; the model's backend can't be relied on to fetch either.
 *   - Inlining avoids leaking an authenticated/presigned URL to the LLM provider.
 *   - We can enforce a content-type allowlist and size caps before sending.
 *
 * SECURITY / ROBUSTNESS:
 *   - HTTPS only. The URL arrives inside an HMAC-verified webhook (the route
 *     verifies the signature before parseInbound), so an external attacker can't
 *     inject a fetch target — but we still treat the host as untrusted data.
 *   - VERIFIED LIVE (2026-06-05): the media URL is an UNAUTHENTICATED proxy on
 *     AgentPhone's own host (api.agentphone.ai/v1/messages/{id}/media) — a plain GET
 *     returns 200, no key needed, no presign/expiry. So the unauthenticated fetch
 *     below always succeeds. We KEEP a defensive 401/403 retry with the API key, but
 *     attach it ONLY when the URL host matches AgentPhone's own origin (a different
 *     host gets no bearer — the key can never leak to a third party). Today it never
 *     fires; it only matters if AgentPhone ever gates the proxy.
 *   - Body size is bounded by STREAMING with a running byte counter (plus a
 *     Content-Length pre-check), so a misbehaving host can't OOM us via a huge or
 *     never-ending body. Fetches run at a bounded CONCURRENCY (not all at once) and
 *     stop once the per-turn aggregate budget is spent, so peak resident memory is
 *     ~concurrency × per-image cap, independent of how many URLs arrive. A per-turn
 *     aggregate cap also keeps the combined request under the model's inline ceiling.
 *   - SSRF guard: literal private / loopback / link-local hosts (incl. the cloud
 *     metadata IP) are rejected before any fetch. The URL still arrives in an
 *     HMAC-verified webhook, so this is defense-in-depth, not the primary control.
 *
 * Everything here is best-effort and fail-OPEN per image: any error (network,
 * timeout, oversize, wrong type) drops that one attachment and the turn proceeds
 * with whatever fetched — an image we can't read must never fail the user's turn.
 */
import type { ContentPart } from './llm.ts';

/** An image content part (narrowed `ContentPart`) carrying a base64 `data:` URI. */
export type ImageContentPart = Extract<ContentPart, { type: 'image_url' }>;

/** Per-request timeout for one media fetch. Bounded so a black-holed URL can't
 *  stall the turn — these fetches sit before the LLM call and run inside the
 *  per-account lease, so this is dead time on the hot path; keep it tight. */
const FETCH_TIMEOUT_MS = 6_000;
/**
 * Max decoded size of a SINGLE inlined image. base64 inflates ~33%, so 7MB raw is
 * ~9.3MB on the wire. Larger attachments are skipped (a resize / Files-API path
 * can come later if real photos routinely exceed this).
 */
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
/**
 * Max combined decoded size across all images in one turn. Gemini caps inline
 * request data near 20MB and base64 inflates ~33%, so ~12MB raw (~16MB encoded)
 * leaves headroom for the text + JSON envelope. Beyond this we drop extra images
 * and proceed with the ones that fit (degrade, never hard-fail the turn).
 */
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
/** Cap images considered per turn — a defensive bound on a burst of attachments. */
const MAX_IMAGES = 8;
/**
 * Max media fetches in flight at once. Bounds peak resident memory to
 * ~FETCH_CONCURRENCY × MAX_IMAGE_BYTES (here ~21MB) regardless of MAX_IMAGES, so a
 * burst of large photos can't spike memory the way an all-at-once Promise.all would.
 * Small because images-per-turn is normally 1; this only caps the rare burst.
 */
const FETCH_CONCURRENCY = 3;
/**
 * Content-types we forward to the model — exactly the raster formats Gemini's
 * vision input accepts. Deliberately NOT a blanket `image/*`: for a NON-PHOTO
 * message the upstream carrier returns an `image/svg+xml` PLACEHOLDER, proxied
 * verbatim through AgentPhone's unauthenticated media endpoint (verified live).
 * This allowlist IS the placeholder filter — SVG (and any other non-raster oddball)
 * is dropped before encoding, so a placeholder can't be base64'd and then 400 the
 * Gemini call, failing an otherwise-fine turn. iPhone HEIC/HEIF is included.
 */
const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/** AgentPhone media-fetch options. `apiBase` is the AgentPhone API origin; the key
 *  is only ever sent to that host (see module doc). */
export interface MediaFetchOptions {
  apiKey?: string;
  apiBase?: string;
}

/** One successfully-fetched image plus its decoded size (for the aggregate cap). */
interface FetchedImage {
  part: ImageContentPart;
  bytes: number;
}

/**
 * Fetch inbound attachment URLs and return the valid images as base64 `data:` URI
 * content parts (input order preserved). Non-images, oversize payloads, and fetch
 * failures are skipped; images past the per-turn aggregate cap are dropped (and
 * logged). Returns `[]` for no input or when nothing usable fetched.
 */
export async function fetchInboundImages(
  mediaUrls: ReadonlyArray<string>,
  opts: MediaFetchOptions = {},
): Promise<ImageContentPart[]> {
  // Dedup across a coalesced burst (the same photo can arrive on two inbounds),
  // then cap the count. Order preserved (Set keeps insertion order).
  const urls = [...new Set(mediaUrls)].slice(0, MAX_IMAGES);
  if (urls.length === 0) return [];

  // Bounded-concurrency pool: at most FETCH_CONCURRENCY fetches in flight, and we
  // stop starting new ones once the per-turn byte budget is spent — so peak memory
  // is ~concurrency × per-image, not (count × per-image), and we don't read bodies
  // we'd only discard. Results are indexed by input position to preserve order.
  const results: Array<FetchedImage | null> = new Array(urls.length).fill(null);
  let committed = 0; // accepted bytes so far — bounds the combined request size
  let next = 0; // next URL index to claim
  let dropped = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      // Budget spent — don't start fetches whose bytes we'd just drop.
      if (committed >= MAX_TOTAL_IMAGE_BYTES) return;
      const i = next++;
      if (i >= urls.length) return;
      const f = await fetchOneImage(urls[i] as string, opts);
      if (f === null) continue;
      if (committed + f.bytes > MAX_TOTAL_IMAGE_BYTES) {
        dropped++;
        continue;
      }
      committed += f.bytes;
      results[i] = f;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, worker),
  );

  if (dropped > 0) {
    console.warn(
      `[media] dropped ${dropped} image(s) over the ${MAX_TOTAL_IMAGE_BYTES}B per-turn cap`,
    );
  }
  return results.filter((f): f is FetchedImage => f !== null).map((f) => f.part);
}

async function fetchOneImage(
  url: string,
  opts: MediaFetchOptions,
): Promise<FetchedImage | null> {
  const target = parseHttpsUrl(url);
  if (!target) {
    console.warn('[media] skipping non-https / invalid media URL');
    return null;
  }
  try {
    let res = await fetchWithTimeout(url);
    // Auth status of AgentPhone media URLs is unverified against the live API, so
    // retry once WITH the bearer key — but ONLY when the unauthenticated attempt
    // was rejected as unauthorized AND the host is AgentPhone's own API origin.
    // A presigned/CDN URL lives on a different host, is public, and must never
    // receive the key.
    if (
      (res.status === 401 || res.status === 403) &&
      opts.apiKey &&
      isAgentPhoneHost(target, opts.apiBase)
    ) {
      res = await fetchWithTimeout(url, opts.apiKey);
    }
    if (!res.ok) {
      console.warn(`[media] fetch ${res.status} for inbound image; skipping`);
      return null;
    }

    const rawType = res.headers.get('content-type') ?? '';
    const contentType = rawType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      // Drops the upstream image/svg+xml placeholder (non-photo messages) and any
      // other type Gemini can't read — before we waste a base64 + a failed call.
      console.warn(`[media] skipping non-photo / unsupported media type "${contentType}"`);
      return null;
    }

    const bytes = await readBounded(res, MAX_IMAGE_BYTES);
    if (bytes === null || bytes.byteLength === 0) {
      console.warn('[media] inbound image empty or over the single-image cap; skipping');
      return null;
    }

    const dataUri = `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
    return { part: { type: 'image_url', image_url: { url: dataUri } }, bytes: bytes.byteLength };
  } catch (err) {
    console.warn('[media] inbound image fetch failed; skipping', err);
    return null;
  }
}

/**
 * Read a response body into memory bounded by `max` bytes. Rejects (returns null)
 * an honest Content-Length over the cap up front, then streams chunk-by-chunk with
 * a running counter so a lying/never-ending body is aborted past the cap instead
 * of buffered whole. Caps memory at ~`max` + one chunk.
 */
async function readBounded(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;

  const body = res.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Parse an https URL; returns the URL or null for any other scheme, a private /
 *  loopback / link-local host (SSRF guard), or invalid input. */
function parseHttpsUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (isPrivateHost(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * True for a literal loopback / private / link-local host — including the cloud
 * metadata IP (169.254.169.254) and localhost-style names. Defense-in-depth so a
 * (signed) media URL can't point our server-side fetch at internal infrastructure.
 * Does NOT resolve DNS, so a public name pointing at a private IP isn't caught —
 * acceptable given the URL already passed HMAC verification.
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return true;
  }
  // IPv6 loopback (::1), link-local (fe80::/10), unique-local (fc00::/7).
  if (h === '::1' || h.startsWith('fe8') || h.startsWith('fe9') ||
      h.startsWith('fea') || h.startsWith('feb') || h.startsWith('fc') || h.startsWith('fd')) {
    return true;
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. metadata endpoint
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared range
  }
  return false;
}

/** True when `url`'s host matches the AgentPhone API origin (configured or default). */
function isAgentPhoneHost(url: URL, apiBase: string | undefined): boolean {
  const base = apiBase && apiBase.length > 0 ? apiBase : undefined;
  if (!base) return false;
  try {
    return url.host === new URL(base).host;
  } catch {
    return false;
  }
}

/** One bounded fetch; adds the bearer header only when `apiKey` is supplied. */
function fetchWithTimeout(url: string, apiKey?: string): Promise<Response> {
  return fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}
