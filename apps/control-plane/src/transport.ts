/**
 * Shared Transport instance.
 *
 * The control plane depends on the Transport PORT, not the concrete provider.
 * We construct the configured implementation once (reading env via the typed
 * config) and expose it behind the interface so it stays swappable. The active
 * provider is selected deployment-wide by `MESSAGING_PROVIDER` (default
 * AgentPhone) — see env.ts.
 */
import {
  AgentPhoneTransport,
  SendblueTransport,
  type Transport,
} from '@imsg/transport';
import { MessagingProvider } from '@imsg/shared';
import { loadEnv } from './env.ts';

let instance: Transport | undefined;

/** Get (and memoize) the process-wide Transport for the active provider. */
export function getTransport(): Transport {
  if (instance) return instance;
  const env = loadEnv();
  if (env.messagingProvider === MessagingProvider.SENDBLUE) {
    instance = new SendblueTransport({
      apiKeyId: env.sendblue.apiKeyId,
      apiSecret: env.sendblue.apiSecret,
      fromNumber: env.sendblue.fromNumber,
      apiBase: env.sendblue.apiBase,
      webhookSecret: env.sendblue.webhookSecret,
    });
  } else {
    instance = new AgentPhoneTransport({
      apiKey: env.agentPhone.apiKey,
      apiBase: env.agentPhone.apiBase,
      agentId: env.agentPhone.agentId,
      webhookSecret: env.agentPhone.webhookSecret,
    });
  }
  return instance;
}

/** Override the Transport (used in tests / alternative providers). */
export function setTransport(t: Transport): void {
  instance = t;
}
