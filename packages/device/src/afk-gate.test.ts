import { describe, expect, test } from 'bun:test';
import { AfkState } from '@imsg/shared';
import { AFK_OFF_NOTICE, messageUserBlockedWhenAfkOff } from './afk-gate.ts';

describe('messageUserBlockedWhenAfkOff', () => {
  test('AFK on: proceeds (returns null, message_user relays)', () => {
    expect(messageUserBlockedWhenAfkOff(AfkState.ON)).toBeNull();
  });

  test('AFK off: short-circuits with a tool error and the not-delivered notice', () => {
    const r = messageUserBlockedWhenAfkOff(AfkState.OFF);
    expect(r).not.toBeNull();
    expect(r?.isError).toBe(true);
    expect(r?.content).toEqual([{ type: 'text', text: AFK_OFF_NOTICE }]);
    // The agent must learn it was NOT delivered and that AFK is the reason.
    expect(AFK_OFF_NOTICE).toContain('Not delivered');
    expect(AFK_OFF_NOTICE).toContain('AFK mode is OFF');
  });
});
