import { describe, expect, test } from 'bun:test';
import {
  isSessionConnected,
  markSessionConnected,
  markSessionDisconnected,
} from './device-connections.ts';

describe('device-connections — live SSE presence registry', () => {
  test('unknown session is not connected', () => {
    expect(isSessionConnected('never-seen')).toBe(false);
  });

  test('connect → connected, disconnect → not connected', () => {
    const s = 'sess-a';
    markSessionConnected(s);
    expect(isSessionConnected(s)).toBe(true);
    markSessionDisconnected(s);
    expect(isSessionConnected(s)).toBe(false);
  });

  test('refcount: overlapping streams stay connected until the LAST closes', () => {
    const s = 'sess-b';
    markSessionConnected(s); // stream 1 opens
    markSessionConnected(s); // stream 2 opens (reconnect overlaps the old)
    markSessionDisconnected(s); // stream 1 closes
    expect(isSessionConnected(s)).toBe(true); // still one live stream
    markSessionDisconnected(s); // stream 2 closes
    expect(isSessionConnected(s)).toBe(false);
  });

  test('over-decrement never drops below zero / flips to negative-connected', () => {
    const s = 'sess-c';
    markSessionDisconnected(s); // stray decrement (should be a no-op)
    expect(isSessionConnected(s)).toBe(false);
    markSessionConnected(s);
    expect(isSessionConnected(s)).toBe(true);
    markSessionDisconnected(s);
    expect(isSessionConnected(s)).toBe(false);
  });

  test('sessions are tracked independently', () => {
    markSessionConnected('sess-d');
    expect(isSessionConnected('sess-d')).toBe(true);
    expect(isSessionConnected('sess-e')).toBe(false);
    markSessionDisconnected('sess-d');
  });
});
