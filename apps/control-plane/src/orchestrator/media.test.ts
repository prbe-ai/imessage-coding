/**
 * Tests for inbound image fetching. `globalThis.fetch` is stubbed per test so no
 * network is hit; the real fetch is restored after each.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { fetchInboundImages } from './media.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A Response carrying raw bytes with an image content-type (status 200). */
function imageResponse(bytes: number[] | Uint8Array, contentType = 'image/png'): Response {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

describe('fetchInboundImages', () => {
  test('empty input returns [] without fetching', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return imageResponse([1]);
    }) as unknown as typeof fetch;
    expect(await fetchInboundImages([])).toEqual([]);
    expect(called).toBe(false);
  });

  test('a valid image is fetched and inlined as a base64 data URI', async () => {
    globalThis.fetch = (async () =>
      imageResponse([1, 2, 3, 4], 'image/jpeg')) as unknown as typeof fetch;
    expect(await fetchInboundImages(['https://cdn/a.jpg'])).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQIDBA==' } },
    ]);
  });

  test('content-type parameters are stripped from the data URI mime', async () => {
    globalThis.fetch = (async () =>
      imageResponse([0], 'image/png; charset=binary')) as unknown as typeof fetch;
    const parts = await fetchInboundImages(['https://cdn/a.png']);
    expect(parts[0]?.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
  });

  test('a non-https URL is skipped (no fetch)', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return imageResponse([1]);
    }) as unknown as typeof fetch;
    expect(await fetchInboundImages(['http://cdn/a.png', 'ftp://x/y'])).toEqual([]);
    expect(called).toBe(false);
  });

  test('a non-image content-type is skipped', async () => {
    globalThis.fetch = (async () =>
      imageResponse([1, 2], 'text/html')) as unknown as typeof fetch;
    expect(await fetchInboundImages(['https://cdn/a'])).toEqual([]);
  });

  test('an image/svg+xml placeholder is skipped (Gemini-unsupported)', async () => {
    // AgentPhone serves a small image/svg+xml placeholder for media-less messages
    // (verified live); SVG isn't a Gemini-supported type, so it must be dropped.
    globalThis.fetch = (async () =>
      imageResponse([1, 2, 3], 'image/svg+xml')) as unknown as typeof fetch;
    expect(await fetchInboundImages(['https://api.agentphone.ai/v1/messages/x/media'])).toEqual([]);
  });

  test('a non-OK response is skipped', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await fetchInboundImages(['https://cdn/a'])).toEqual([]);
  });

  test('a single image over the per-image cap is skipped', async () => {
    const big = new Uint8Array(7 * 1024 * 1024 + 1);
    globalThis.fetch = (async () => imageResponse(big)) as unknown as typeof fetch;
    expect(await fetchInboundImages(['https://cdn/big.png'])).toEqual([]);
  });

  test('a fetch rejection is swallowed (fail-open per image)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await fetchInboundImages(['https://cdn/a'])).toEqual([]);
  });

  test('a 401 retries ONCE with the bearer key when the host is AgentPhone', async () => {
    const auths: Array<string | undefined> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      auths.push(headers['Authorization']);
      if (auths.length === 1) return new Response('unauth', { status: 401 });
      return imageResponse([9], 'image/png');
    }) as unknown as typeof fetch;

    const parts = await fetchInboundImages(['https://api.agentphone.ai/m/a.gif'], {
      apiKey: 'SECRET_KEY',
      apiBase: 'https://api.agentphone.ai',
    });
    expect(parts.length).toBe(1);
    expect(auths).toEqual([undefined, 'Bearer SECRET_KEY']); // try unauth, then bearer
  });

  test('a 401 from a NON-AgentPhone host does NOT retry (key never leaves)', async () => {
    const auths: Array<string | undefined> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      auths.push(headers['Authorization']);
      return new Response('unauth', { status: 401 });
    }) as unknown as typeof fetch;

    const parts = await fetchInboundImages(['https://some-cdn.example/a.png'], {
      apiKey: 'SECRET_KEY',
      apiBase: 'https://api.agentphone.ai',
    });
    expect(parts).toEqual([]);
    expect(auths).toEqual([undefined]); // exactly one try, no bearer
  });

  test('a 401 without an api key does NOT retry (skipped)', async () => {
    let count = 0;
    globalThis.fetch = (async () => {
      count++;
      return new Response('unauth', { status: 401 });
    }) as unknown as typeof fetch;
    expect(await fetchInboundImages(['https://cdn/a'])).toEqual([]);
    expect(count).toBe(1);
  });

  test('multiple images preserve input order; failures drop out', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('bad')) return new Response('x', { status: 500 });
      return imageResponse([1], 'image/png');
    }) as unknown as typeof fetch;
    const parts = await fetchInboundImages([
      'https://cdn/1.png',
      'https://cdn/bad',
      'https://cdn/2.png',
    ]);
    expect(parts.length).toBe(2); // the 500 in the middle is dropped
  });

  test('images past the per-turn aggregate cap are dropped (order preserved)', async () => {
    const fiveMb = new Uint8Array(5 * 1024 * 1024); // 3 × 5MB = 15MB > 12MB cap
    globalThis.fetch = (async () => imageResponse(fiveMb)) as unknown as typeof fetch;
    const parts = await fetchInboundImages([
      'https://cdn/1.png',
      'https://cdn/2.png',
      'https://cdn/3.png',
    ]);
    expect(parts.length).toBe(2); // first two fit (10MB); third would exceed 12MB
  });

  test('a duplicate media URL in the burst is fetched once', async () => {
    let count = 0;
    globalThis.fetch = (async () => {
      count++;
      return imageResponse([1, 2], 'image/png');
    }) as unknown as typeof fetch;
    const parts = await fetchInboundImages([
      'https://cdn/same.png',
      'https://cdn/same.png',
    ]);
    expect(parts.length).toBe(1);
    expect(count).toBe(1); // deduped before fetch
  });

  test('private / loopback / metadata hosts are rejected before any fetch (SSRF)', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return imageResponse([1]);
    }) as unknown as typeof fetch;
    const parts = await fetchInboundImages([
      'https://169.254.169.254/latest/meta-data/', // cloud metadata
      'https://127.0.0.1/x.png',
      'https://localhost/x.png',
      'https://10.0.0.5/x.png',
      'https://[::1]/x.png',
    ]);
    expect(parts).toEqual([]);
    expect(called).toBe(false); // never fetched
  });
});
