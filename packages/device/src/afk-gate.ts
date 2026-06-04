/**
 * @imsg/device — message_user AFK gate (pure decision, unit-testable).
 *
 * When AFK is OFF the user is at the keyboard and sees the agent's output
 * directly, and the control plane DROPS a status relay for a non-AFK session
 * (apps/control-plane/src/routes/device.ts → `{relayed:false}`). So calling
 * `message_user` while AFK is off never reaches the user — relaying anyway is a
 * silent no-op that fools the agent into thinking it notified them. We surface
 * that to the agent as a tool error instead.
 *
 * This lives in its own module (not channel.ts) because channel.ts boots the MCP
 * stdio server at import time; keeping the decision pure here makes it testable
 * without that side effect.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AfkState } from '@imsg/shared';

/** Agent-facing text when message_user is called while AFK is off. */
export const AFK_OFF_NOTICE =
  'Not delivered — AFK mode is OFF. The user is at their terminal and sees your output directly; ' +
  'message_user only reaches them over iMessage while AFK is on. Do not call message_user when AFK ' +
  'is off — just respond in your normal output.';

/**
 * Decide what `message_user` should do for the given AFK state. Returns the error
 * result to short-circuit with when AFK is OFF, or `null` to proceed with the
 * relay when AFK is ON.
 */
export function messageUserBlockedWhenAfkOff(afk: AfkState): CallToolResult | null {
  if (afk === AfkState.ON) return null;
  return { isError: true, content: [{ type: 'text', text: AFK_OFF_NOTICE }] };
}
