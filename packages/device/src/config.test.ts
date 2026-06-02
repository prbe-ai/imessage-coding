/**
 * Unit tests for control-plane URL resolution.
 *
 * This is the exact logic that silently routed the runtime MCP server to
 * localhost (Claude Code spawns it with no env, so the build-baked value must
 * win over the default). `resolveControlPlaneUrl` is pure — env + parsed
 * build-config in, URL out — so we pin the precedence here without touching the
 * filesystem. The file-read half (`buildConfig()`) only has to guarantee it
 * returns null (never throws) on a missing/malformed file; a null result is the
 * same precedence input as "no baked config", covered below.
 *
 *   precedence: IMSG_CONTROL_PLANE_URL > CONTROL_PLANE_URL > baked > localhost
 */
import { describe, expect, test } from 'bun:test';

import { pickEagerSessionId, resolveControlPlaneUrl } from './config.ts';

const DEFAULT = 'http://localhost:8080';
const BAKED = { controlPlaneUrl: 'https://baked.example.com' };

describe('resolveControlPlaneUrl', () => {
  test('IMSG_CONTROL_PLANE_URL env wins over baked config', () => {
    expect(resolveControlPlaneUrl({ IMSG_CONTROL_PLANE_URL: 'https://env.example.com/' }, BAKED)).toBe(
      'https://env.example.com',
    );
  });

  test('CONTROL_PLANE_URL env used when IMSG_ is unset', () => {
    expect(resolveControlPlaneUrl({ CONTROL_PLANE_URL: 'https://cp.example.com' }, BAKED)).toBe(
      'https://cp.example.com',
    );
  });

  test('baked build-config used when no env is set', () => {
    expect(resolveControlPlaneUrl({}, BAKED)).toBe('https://baked.example.com');
  });

  test('missing build-config (null) falls back to the localhost default', () => {
    expect(resolveControlPlaneUrl({}, null)).toBe(DEFAULT);
  });

  test('empty / whitespace values are treated as unset (no accidental shadow)', () => {
    expect(resolveControlPlaneUrl({ IMSG_CONTROL_PLANE_URL: '   ' }, { controlPlaneUrl: '' })).toBe(
      DEFAULT,
    );
  });

  test('trailing slashes are stripped', () => {
    expect(resolveControlPlaneUrl({}, { controlPlaneUrl: 'https://x.example.com///' })).toBe(
      'https://x.example.com',
    );
  });
});

describe('pickEagerSessionId', () => {
  const SID = '11111111-1111-1111-1111-111111111111';
  const NATIVE = '22222222-2222-2222-2222-222222222222';

  test('IMSG_SESSION_ID override wins over the CC-native id', () => {
    expect(pickEagerSessionId({ IMSG_SESSION_ID: SID, CLAUDE_CODE_SESSION_ID: NATIVE })).toBe(SID);
  });

  test('CLAUDE_CODE_SESSION_ID is used when no override is set (the same-cwd fix)', () => {
    expect(pickEagerSessionId({ CLAUDE_CODE_SESSION_ID: NATIVE })).toBe(NATIVE);
  });

  test('returns null when neither is set (caller falls back to handshake/random)', () => {
    expect(pickEagerSessionId({})).toBeNull();
  });

  test('a non-UUID CLAUDE_CODE_SESSION_ID is rejected so the handshake can recover', () => {
    expect(pickEagerSessionId({ CLAUDE_CODE_SESSION_ID: 'not-a-uuid' })).toBeNull();
    expect(pickEagerSessionId({ CLAUDE_CODE_SESSION_ID: 'garbage 123' })).toBeNull();
  });

  test('whitespace-only / blank env values are ignored, not treated as ids', () => {
    expect(pickEagerSessionId({ IMSG_SESSION_ID: '   ', CLAUDE_CODE_SESSION_ID: NATIVE })).toBe(NATIVE);
    expect(pickEagerSessionId({ CLAUDE_CODE_SESSION_ID: '  ' })).toBeNull();
  });

  test('trims surrounding whitespace on the chosen id', () => {
    expect(pickEagerSessionId({ CLAUDE_CODE_SESSION_ID: `  ${NATIVE}  ` })).toBe(NATIVE);
  });

  test('explicit IMSG_SESSION_ID override is honored as-is (not UUID-validated)', () => {
    expect(pickEagerSessionId({ IMSG_SESSION_ID: 'manual-test-id' })).toBe('manual-test-id');
  });
});
