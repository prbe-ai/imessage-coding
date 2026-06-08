/**
 * Unit tests for clampVerbatim (types.ts) — the PURE one-screen cap shared by the
 * device egress clamp and the server-side verbatim formatter. A `verbatim: true`
 * message_user is sent to the user unshaped (LLM bypassed), so this is the only thing
 * keeping a long plan dump from flooding the iMessage thread. No DB, no network.
 */
import { describe, expect, test } from 'bun:test';
import {
  VERBATIM_TEXT_MAX_LEN,
  VERBATIM_TRUNCATION_MARKER,
  clampVerbatim,
  stripControlBidi,
} from './types.ts';

describe('clampVerbatim — one-screen cap for verbatim relays', () => {
  test('text at or under the cap is returned untouched (no marker)', () => {
    const exact = 'a'.repeat(VERBATIM_TEXT_MAX_LEN);
    expect(clampVerbatim(exact)).toBe(exact);
    expect(clampVerbatim('short plan')).toBe('short plan');
  });

  test('over-cap text is tail-truncated and gets the truncation marker', () => {
    const long = 'b'.repeat(VERBATIM_TEXT_MAX_LEN + 250);
    const out = clampVerbatim(long);
    expect(out.endsWith(VERBATIM_TRUNCATION_MARKER)).toBe(true);
    // The kept body never exceeds the cap (marker is extra signal, not content).
    expect(out.slice(0, out.length - VERBATIM_TRUNCATION_MARKER.length).length).toBeLessThanOrEqual(
      VERBATIM_TEXT_MAX_LEN,
    );
    expect(out.includes('b'.repeat(VERBATIM_TEXT_MAX_LEN + 1))).toBe(false);
  });

  test('is IDEMPOTENT — re-clamping already-clamped text is stable (device + server both apply it)', () => {
    const long = 'c'.repeat(VERBATIM_TEXT_MAX_LEN + 500);
    const once = clampVerbatim(long);
    expect(clampVerbatim(once)).toBe(once);
  });
});

describe('stripControlBidi — drop control/bidi spoofing chars, keep structure', () => {
  // Built via fromCharCode so the test source stays pure ASCII (no literal control chars).
  const RLO = String.fromCharCode(0x202e); // right-to-left override
  const ZWSP = String.fromCharCode(0x200b); // zero-width space
  const NUL = String.fromCharCode(0x00);
  const ISO = String.fromCharCode(0x2066); // left-to-right isolate

  test('strips RTL override, zero-width space, NUL, and bidi isolate', () => {
    expect(stripControlBidi('a' + RLO + 'b' + ZWSP + 'c' + NUL + ISO + 'd')).toBe('abcd');
  });

  test('preserves newlines, tabs, CR, and quotes — a verbatim plan/diff needs them', () => {
    const body = 'line1\n\tindented "quoted" code\r\nline2';
    expect(stripControlBidi(body)).toBe(body);
  });

  test('a clean string is returned unchanged', () => {
    expect(stripControlBidi('Plan: do A, then B.')).toBe('Plan: do A, then B.');
  });
});
