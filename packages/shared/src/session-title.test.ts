/**
 * Unit tests for the session-title helpers (types.ts) — the PURE cleaning +
 * empty→clear rule shared by the tap's auto-title capture, the agent's
 * rename_session device route, and the dashboard's BFF rename route. No DB, no
 * network. The DB-backed setManualTitle / COALESCE read is covered by the deploy
 * smoke (same convention as the rest of repo.ts's SQL).
 */
import { describe, expect, test } from 'bun:test';
import {
  SESSION_TITLE_MAX_LEN,
  cleanSessionTitle,
  manualTitleValue,
} from './types.ts';

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

describe('manualTitleValue — the empty→clear (null) rule', () => {
  test('a real name returns the cleaned string', () => {
    expect(manualTitleValue('  Fixing CI  ')).toBe('Fixing CI');
  });

  test('empty string clears the override (null → revert to auto-title)', () => {
    expect(manualTitleValue('')).toBeNull();
  });

  test('whitespace-only clears the override (null)', () => {
    expect(manualTitleValue('   \n ')).toBeNull();
  });

  test('clamps an over-long name to the cap, still non-null', () => {
    const v = manualTitleValue('y'.repeat(SESSION_TITLE_MAX_LEN + 10));
    expect(v).not.toBeNull();
    expect(v?.length).toBe(SESSION_TITLE_MAX_LEN);
  });
});
