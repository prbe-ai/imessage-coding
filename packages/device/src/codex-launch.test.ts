/**
 * Unit tests for the `imsg codex` launcher's pure helpers (port + argv + URL
 * construction). The process orchestration (ensureAppServer/launchCodex) shells
 * out to a real `codex` and is covered by manual end-to-end runs, not here.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CODEX_APPSERVER_PORT,
  appServerReadyUrl,
  appServerSpawnArgs,
  appServerWsUrl,
  remoteTuiArgs,
  resolveCodexPort,
} from './codex-launch.ts';

describe('resolveCodexPort', () => {
  test('defaults when IMSG_CODEX_APPSERVER_PORT is unset', () => {
    expect(resolveCodexPort({})).toBe(DEFAULT_CODEX_APPSERVER_PORT);
  });

  test('uses a valid override', () => {
    expect(resolveCodexPort({ IMSG_CODEX_APPSERVER_PORT: '9123' })).toBe(9123);
  });

  test('rejects out-of-range / garbage and falls back to default', () => {
    expect(resolveCodexPort({ IMSG_CODEX_APPSERVER_PORT: '0' })).toBe(DEFAULT_CODEX_APPSERVER_PORT);
    expect(resolveCodexPort({ IMSG_CODEX_APPSERVER_PORT: '70000' })).toBe(DEFAULT_CODEX_APPSERVER_PORT);
    expect(resolveCodexPort({ IMSG_CODEX_APPSERVER_PORT: 'abc' })).toBe(DEFAULT_CODEX_APPSERVER_PORT);
  });
});

describe('url + argv construction', () => {
  test('ws + ready URLs share the loopback host and port', () => {
    expect(appServerWsUrl(8765)).toBe('ws://127.0.0.1:8765');
    expect(appServerReadyUrl(8765)).toBe('http://127.0.0.1:8765/readyz');
  });

  test('app-server spawn args bind the WS listener', () => {
    expect(appServerSpawnArgs(8765)).toEqual(['app-server', '--listen', 'ws://127.0.0.1:8765']);
  });

  test('remote TUI args attach to the app-server and forward user args', () => {
    expect(remoteTuiArgs(8765, ['--yolo', 'do a thing'])).toEqual([
      '--remote',
      'ws://127.0.0.1:8765',
      '--yolo',
      'do a thing',
    ]);
  });

  test('remote TUI args with no passthrough', () => {
    expect(remoteTuiArgs(8765, [])).toEqual(['--remote', 'ws://127.0.0.1:8765']);
  });
});
