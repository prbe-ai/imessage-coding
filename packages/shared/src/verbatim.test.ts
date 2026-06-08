/**
 * Unit tests for the PURE verbatim helpers (types.ts). `fitsVerbatim` is the GATE
 * that decides whether a `verbatim: true` message_user goes out as-is (LLM bypassed)
 * or falls back to the orchestrator to be condensed — over-cap text is NEVER truncated.
 * `stripControlBidi` is the server-side scrub applied to the bypassed text. No DB, no
 * network.
 */
import { describe, expect, test } from 'bun:test';
import { VERBATIM_TEXT_MAX_LEN, fitsVerbatim, stripControlBidi } from './types.ts';

describe('fitsVerbatim — one-screen gate (no truncation, fall back to condense)', () => {
  test('text at or under the cap fits (sent verbatim)', () => {
    expect(fitsVerbatim('short plan')).toBe(true);
    expect(fitsVerbatim('a'.repeat(VERBATIM_TEXT_MAX_LEN))).toBe(true);
  });

  test('text over the cap does NOT fit (orchestrator condenses it instead)', () => {
    expect(fitsVerbatim('a'.repeat(VERBATIM_TEXT_MAX_LEN + 1))).toBe(false);
    expect(fitsVerbatim('b'.repeat(VERBATIM_TEXT_MAX_LEN + 5000))).toBe(false);
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
