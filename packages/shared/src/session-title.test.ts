/**
 * Unit tests for the session-title helper (types.ts) — the PURE cleaning rule
 * shared by the tap's auto-title capture, the agent's rename_session device route,
 * the dashboard's BFF rename route, and the orchestrator's rename tool. No DB, no
 * network. The DB-backed setTitle / single-column read is covered by the deploy
 * smoke (same convention as the rest of repo.ts's SQL). Empty cleans to '' and
 * every caller treats that as a no-op — a label is never blanked.
 */
import { describe, expect, test } from 'bun:test';
import { SESSION_TITLE_MAX_LEN, cleanSessionTitle } from './types.ts';

describe('cleanSessionTitle — single trimmed line within the cap', () => {
  test('collapses internal whitespace runs to one space', () => {
    expect(cleanSessionTitle('Auth    refactor')).toBe('Auth refactor');
  });

  test('flattens newlines/tabs to a single line (no injection past the label)', () => {
    expect(cleanSessionTitle('line one\n\tline two')).toBe('line one line two');
  });

  test('trims leading/trailing whitespace', () => {
    expect(cleanSessionTitle('  hello  ')).toBe('hello');
  });

  test('clamps to SESSION_TITLE_MAX_LEN characters', () => {
    const long = 'x'.repeat(SESSION_TITLE_MAX_LEN + 50);
    expect(cleanSessionTitle(long).length).toBe(SESSION_TITLE_MAX_LEN);
  });

  test('whitespace-only input cleans to empty', () => {
    expect(cleanSessionTitle('   \n\t ')).toBe('');
  });

  test('empty input stays empty', () => {
    expect(cleanSessionTitle('')).toBe('');
  });

  test('clamp happens AFTER collapsing, so a padded short name survives', () => {
    expect(cleanSessionTitle('  Fixing CI  ')).toBe('Fixing CI');
  });
});
