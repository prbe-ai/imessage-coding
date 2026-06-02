/**
 * Tool-surface invariant for the assistant turn. `assistantTools(mode)` is the
 * seam that enforces "only a user-message turn may resolve/steer; the two
 * agent-driven turns are NOTIFY-only (text_user only)". A regression here (e.g.
 * a future `mode === 'agent_event'` check that forgets the new `agent_message`
 * mode) would silently re-expose respond_to_request / send_to_session to a
 * notify-only turn — letting an agent's own status text reach the resolution
 * tools. Pure logic — importing prompt.ts opens no DB/network connection.
 */
import { describe, expect, test } from 'bun:test';
import { assistantTools } from './prompt.ts';

// Sorted, comma-joined tool names — compared with `.toBe` (the matcher this
// repo's bun-types exposes; `.toEqual` is not typed here).
const toolNames = (mode: 'user_message' | 'agent_event' | 'agent_message'): string =>
  assistantTools(mode)
    .map((t) => t.function.name)
    .sort()
    .join(',');

describe('assistantTools — notify-only gate', () => {
  test('user_message exposes all three capable tools', () => {
    expect(toolNames('user_message')).toBe('respond_to_request,send_to_session,text_user');
  });

  test('agent_event is notify-only (text_user only)', () => {
    expect(toolNames('agent_event')).toBe('text_user');
  });

  test('agent_message (the status-relay split) is ALSO notify-only', () => {
    expect(toolNames('agent_message')).toBe('text_user');
  });
});
