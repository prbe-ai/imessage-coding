/**
 * Tool-surface invariant for the assistant turn. `assistantTools(mode)` is the
 * seam that enforces "only a user-message turn may message agents / read / change
 * settings; the two agent-driven turns are NOTIFY-only (message_user only)". A
 * regression here (e.g. a future `mode === 'agent_event'` check that forgets the
 * `agent_message` mode) would silently re-expose message_agent to a notify-only
 * turn — letting an agent's own status text reach the action tools. Pure logic —
 * importing prompt.ts opens no DB/network connection.
 *
 * Also covers the texting-style contract (plain text / no ids / may stay silent)
 * and the coalesced-burst rendering (a user_message turn carries a BATCH and the
 * turn context must frame a multi-message burst as ONE combined request).
 */
import { describe, expect, test } from 'bun:test';
import { MessageChannel, type InboundMessage } from '@imsg/shared';
import { assistantTools, buildTurnMessages, systemPrompt } from './prompt.ts';

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
  test('user_message exposes the full tool surface (2 messaging, 2 read, 1 write)', () => {
    expect(toolNames('user_message')).toBe(
      'get_session_data,get_session_state,message_agent,message_user,update_session_state',
    );
  });

  test('agent_event is notify-only (message_user only)', () => {
    expect(toolNames('agent_event')).toBe('message_user');
  });

  test('agent_message (the status-relay split) is ALSO notify-only', () => {
    expect(toolNames('agent_message')).toBe('message_user');
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

// REGRESSION GUARD for the approve-loop: AgentPhone forwards NO link for a typed
// inline reply, so "reply directly to this message" guidance can never bind and
// traps the user in a loop (only a tap-back/reaction binds). The model's standing
// instructions must never instruct a typed reply to choose/approve — only a
// tap-back — and message_user must keep its `surface_request` option as the way to
// present a tappable permission. Locks the invariants so a future copy edit can't
// reintroduce them.
describe('binding guidance — never instruct a typed reply to bind', () => {
  const agentDesc = (): string =>
    assistantTools('user_message').find((t) => t.function.name === 'message_agent')!.function
      .description;
  const userDesc = (): string =>
    assistantTools('user_message').find((t) => t.function.name === 'message_user')!.function
      .description;

  test('system prompt steers to tap-back, never "reply directly"', () => {
    const sp = systemPrompt();
    expect(/reply directly/i.test(sp)).toBe(false);
    expect(/tap-back/i.test(sp)).toBe(true);
  });

  test('message_agent allow guidance leans on tap-back, never "reply directly"', () => {
    expect(/replied directly|reply directly/i.test(agentDesc())).toBe(false);
    expect(/tapped-back|tap-back/i.test(agentDesc())).toBe(true);
  });

  test('message_user keeps surface_request — the tappable way to present a permission', () => {
    expect(userDesc().includes('surface_request')).toBe(true);
    expect(/tap-backable|tap-back/i.test(userDesc())).toBe(true);
  });
});

// The texting-style contract from the screenshot fixes: iMessage shows raw
// Markdown, so the model must write plain text; it must not leak internal ids; and
// it is explicitly allowed to stay silent when nothing needs saying.
describe('texting style — plain text, no ids, may stay silent', () => {
  const sp = systemPrompt();

  test('forbids Markdown explicitly', () => {
    expect(/Markdown/i.test(sp)).toBe(true);
  });

  test('tells the model not to put internal/session ids in user messages', () => {
    expect(/session ids|internal ids/i.test(sp)).toBe(true);
  });

  test('permits staying silent when nothing needs saying', () => {
    expect(/Silence is fine|do NOT have to reply/i.test(sp)).toBe(true);
  });
});
