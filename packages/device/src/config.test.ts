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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentKind } from '@imsg/shared';
import {
  agentKind,
  defaultDeviceDir,
  deviceDir,
  legacyDeviceDir,
  pickEagerSessionId,
  relocateLegacyState,
  resolveControlPlaneUrl,
  shouldMigrateLegacy,
} from './config.ts';

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

describe('agentKind', () => {
  test('IMSG_AGENT_KIND=codex resolves to CODEX', () => {
    expect(agentKind({ IMSG_AGENT_KIND: 'codex' })).toBe(AgentKind.CODEX);
  });

  test('IMSG_AGENT_KIND=claude-code resolves to CLAUDE_CODE', () => {
    expect(agentKind({ IMSG_AGENT_KIND: 'claude-code' })).toBe(AgentKind.CLAUDE_CODE);
  });

  test('unset defaults to CLAUDE_CODE (byte-for-byte prior behavior)', () => {
    expect(agentKind({})).toBe(AgentKind.CLAUDE_CODE);
  });

  test('a garbage / unknown value defaults to CLAUDE_CODE', () => {
    expect(agentKind({ IMSG_AGENT_KIND: 'not-an-agent' })).toBe(AgentKind.CLAUDE_CODE);
    expect(agentKind({ IMSG_AGENT_KIND: 'CODEX' })).toBe(AgentKind.CLAUDE_CODE); // case-sensitive
  });

  test('whitespace-padded value is trimmed before validation', () => {
    expect(agentKind({ IMSG_AGENT_KIND: '  codex  ' })).toBe(AgentKind.CODEX);
  });

  test('blank / whitespace-only value defaults to CLAUDE_CODE', () => {
    expect(agentKind({ IMSG_AGENT_KIND: '   ' })).toBe(AgentKind.CLAUDE_CODE);
  });
});

describe('device dir', () => {
  test('default is the neutral, agent-agnostic ~/.imsg', () => {
    expect(defaultDeviceDir()).toBe(join(homedir(), '.imsg'));
  });

  test('legacy dir is the pre-0.1.7 location under ~/.claude/plugins', () => {
    expect(legacyDeviceDir()).toBe(join(homedir(), '.claude', 'plugins', 'imsg-device'));
  });

  test('IMSG_DEVICE_DIR overrides the default (trimmed)', () => {
    const prev = process.env.IMSG_DEVICE_DIR;
    try {
      process.env.IMSG_DEVICE_DIR = '  /tmp/custom-imsg  ';
      expect(deviceDir()).toBe('/tmp/custom-imsg');
    } finally {
      if (prev === undefined) delete process.env.IMSG_DEVICE_DIR;
      else process.env.IMSG_DEVICE_DIR = prev;
    }
  });

  test('falls back to the default when IMSG_DEVICE_DIR is unset', () => {
    const prev = process.env.IMSG_DEVICE_DIR;
    try {
      delete process.env.IMSG_DEVICE_DIR;
      expect(deviceDir()).toBe(defaultDeviceDir());
    } finally {
      if (prev !== undefined) process.env.IMSG_DEVICE_DIR = prev;
    }
  });
});

describe('shouldMigrateLegacy', () => {
  const NEW = join(homedir(), '.imsg');
  const LEGACY = join(homedir(), '.claude', 'plugins', 'imsg-device');
  const base = {
    target: NEW,
    newDefault: NEW,
    legacyDir: LEGACY,
    targetHasSentinel: false,
    legacyExists: true,
  };

  test('migrates the default relocation when legacy exists and no sentinel', () => {
    expect(shouldMigrateLegacy(base)).toBe(true);
  });

  test('skips an explicit custom dir (target !== newDefault) — never auto-populated', () => {
    expect(shouldMigrateLegacy({ ...base, target: '/tmp/custom-imsg' })).toBe(false);
  });

  test('skips when already migrated (sentinel present)', () => {
    expect(shouldMigrateLegacy({ ...base, targetHasSentinel: true })).toBe(false);
  });

  test('skips when there is nothing to migrate (legacy absent)', () => {
    expect(shouldMigrateLegacy({ ...base, legacyExists: false })).toBe(false);
  });

  test('skips the degenerate case where target equals the legacy dir', () => {
    expect(shouldMigrateLegacy({ ...base, target: LEGACY, newDefault: LEGACY })).toBe(false);
  });
});

describe('relocateLegacyState', () => {
  test('non-destructively copies the legacy tree, stamps the sentinel, and never clobbers', () => {
    const sb = mkdtempSync(join(tmpdir(), 'imsg-relocate-'));
    try {
      const legacy = join(sb, 'legacy');
      const target = join(sb, 'newdir');
      const sentinel = join(target, '.migrated');
      mkdirSync(join(legacy, 'sessions'), { recursive: true });
      writeFileSync(join(legacy, 'afk.state'), 'on');
      writeFileSync(join(legacy, '.token'), 'secret');
      writeFileSync(join(legacy, 'sessions', 's1.cursor.json'), '{"byteOffset":42}');

      // 1) first copy brings everything over + stamps the sentinel; legacy intact.
      expect(relocateLegacyState(legacy, target, sentinel)).toBe(true);
      expect(readFileSync(join(target, 'afk.state'), 'utf8')).toBe('on');
      expect(readFileSync(join(target, '.token'), 'utf8')).toBe('secret');
      expect(readFileSync(join(target, 'sessions', 's1.cursor.json'), 'utf8')).toBe('{"byteOffset":42}');
      expect(existsSync(sentinel)).toBe(true);
      expect(existsSync(join(legacy, 'afk.state'))).toBe(true);

      // 2) fresher state already in target must NOT be clobbered (force:false).
      writeFileSync(join(target, 'afk.state'), 'off');
      relocateLegacyState(legacy, target, sentinel);
      expect(readFileSync(join(target, 'afk.state'), 'utf8')).toBe('off');

      // 3) a file present only in legacy is filled in on a later run.
      writeFileSync(join(legacy, 'newfile'), 'added-later');
      relocateLegacyState(legacy, target, sentinel);
      expect(readFileSync(join(target, 'newfile'), 'utf8')).toBe('added-later');
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});
