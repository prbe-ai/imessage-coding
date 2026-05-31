/**
 * @imsg/transport — swappable messaging transport.
 *
 * Exports the Transport PORT (interface) and the AgentPhone implementation.
 * Consumers (the control plane) should depend on `Transport`, not the concrete
 * class, so the provider stays swappable.
 */
export type { Transport, SendResult } from './transport.ts';
export {
  AgentPhoneTransport,
  AGENTPHONE_SIGNATURE_HEADER,
  AGENTPHONE_TIMESTAMP_HEADER,
  AGENTPHONE_WEBHOOK_ID_HEADER,
  type AgentPhoneConfig,
} from './agentphone.ts';
