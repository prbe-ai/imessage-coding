/**
 * Unit tests for the `imsg codex` launcher's pure helpers (port + argv + URL
 * construction). The process orchestration (startAppServer/launchCodex) shells
 * out to a real `codex` and is covered by manual end-to-end runs, not here.
 */
import { describe, expect, test } from 'bun:test';
import {
  appServerReadyUrl,
  appServerSpawnArgs,
  appServerWsUrl,
  pickFreePort,
  remoteTuiArgs,
  resolveCodexPort,
} from './codex-launch.ts';

describe('resolveCodexPort', () => {
  test('null when IMSG_CODEX_APPSERVER_PORT is unset (→ caller picks a free port)', () => {
    expect(resolveCodexPort({})).toBeNull();
  });

  test('uses a valid override', () => {
    expect(resolveCodexPort({ IMSG_CODEX_APPSERVER_PORT: '9123' })).toBe(9123);
  });

  test('rejects out-of-range / garbage → null (free port)', () => {
    expect(resolveCodexPort({ IMSG_CODEX_APPSERVER_PORT: '0' })).toBeNull();
    expect(resolveCodexPort({ IMSG_CODEX_APPSERVER_PORT: '70000' })).toBeNull();
    expect(resolveCodexPort({ IMSG_CODEX_APPSERVER_PORT: 'abc' })).toBeNull();
  });
});

describe('pickFreePort', () => {
  test('returns a bindable loopback port in range', async () => {
    const port = await pickFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
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
