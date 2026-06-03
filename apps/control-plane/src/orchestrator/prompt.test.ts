/**
 * Tool-surface invariant for the assistant turn. `assistantTools(mode)` is the
 * seam that enforces "only a user-message turn may resolve/steer; the two
 * agent-driven turns are NOTIFY-only (text_user only)". A regression here (e.g.
 * a future `mode === 'agent_event'` check that forgets the new `agent_message`
 * mode) would silently re-expose respond_to_request / send_to_session to a
 * notify-only turn — letting an agent's own status text reach the resolution
 * tools. Pure logic — importing prompt.ts opens no DB/network connection.
 *
 * Also covers the coalesced-burst rendering: a user_message turn now carries a
 * BATCH of inbound messages, and the turn context must tell the model to treat a
 * multi-message burst as ONE combined request (the typo-correction case).
 */
import { describe, expect, test } from 'bun:test';
import { MessageChannel, type InboundMessage } from '@imsg/shared';
import { assistantTools, buildTurnMessages } from './prompt.ts';

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    from: '+15551234567',
    text: 'hello',
    channel: MessageChannel.IMESSAGE,
    messageId: 'msg-1',
    ...overrides,
  };
}

/** The turn context is the second message's content (system + context user). */
function renderUserTurn(inbounds: ReadonlyArray<InboundMessage>): string {
  const msgs = buildTurnMessages({
    trigger: { kind: 'user_message', inbounds },
    pending: [],
    sessions: [],
    history: [],
    activity: {},
  });
  return msgs[1]?.content ?? '';
}

// Sorted, comma-joined tool names — compared with `.toBe` (the matcher this
// repo's bun-types exposes; `.toEqual` is not typed here).
const toolNames = (mode: 'user_message' | 'agent_event' | 'agent_message'): string =>
  assistantTools(mode)
    .map((t) => t.function.name)
    .sort()
    .join(',');

describe('assistantTools — notify-only gate', () => {
  test('user_message exposes all four capable tools', () => {
    expect(toolNames('user_message')).toBe(
      'respond_to_request,send_to_session,set_afk,text_user',
    );
  });

  test('agent_event is notify-only (text_user only)', () => {
    expect(toolNames('agent_event')).toBe('text_user');
  });

  test('agent_message (the status-relay split) is ALSO notify-only', () => {
    expect(toolNames('agent_message')).toBe('text_user');
  });
});

describe('buildTurnMessages — coalesced user burst rendering', () => {
  test('a single inbound renders the simple "THE USER JUST SENT" form', () => {
    const ctx = renderUserTurn([inbound({ text: 'add tests' })]);
    expect(ctx.includes('THE USER JUST SENT:')).toBe(true);
    expect(ctx.includes('"add tests"')).toBe(true);
    // Not the multi-message framing for a lone message.
    expect(ctx.includes('QUICK SUCCESSION')).toBe(false);
  });

  test('a multi-message burst is framed as ONE combined request, listing each', () => {
    const ctx = renderUserTurn([
      inbound({ text: 'add tets', messageId: 'm1' }),
      inbound({ text: 'add tests', messageId: 'm2' }),
    ]);
    // The model is told to treat the burst as one request (the typo case).
    expect(ctx.includes('QUICK SUCCESSION')).toBe(true);
    expect(ctx.includes('single reply')).toBe(true);
    // Both messages are surfaced, in arrival order.
    expect(ctx.indexOf('"add tets"') < ctx.indexOf('"add tests"')).toBe(true);
  });

  test('a tap-back / inline reply in the burst is annotated with its bound id', () => {
    const ctx = renderUserTurn([
      inbound({ text: 'first', messageId: 'm1' }),
      inbound({ text: 'this one', messageId: 'm2', reactionTo: 'notify-XYZ' }),
    ]);
    expect(ctx.includes('notify-XYZ')).toBe(true);
  });
});
