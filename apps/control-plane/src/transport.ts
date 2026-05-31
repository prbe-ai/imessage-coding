/**
 * Shared Transport instance.
 *
 * The control plane depends on the Transport PORT, not the concrete provider.
 * We construct the AgentPhone implementation once (reading env via the typed
 * config) and expose it behind the interface so it stays swappable.
 */
import { AgentPhoneTransport, type Transport } from '@imsg/transport';
import { loadEnv } from './env.ts';

let instance: Transport | undefined;

/** Get (and memoize) the process-wide Transport. */
export function getTransport(): Transport {
  if (instance) return instance;
  const { agentPhone } = loadEnv();
  instance = new AgentPhoneTransport({
    apiKey: agentPhone.apiKey,
    apiBase: agentPhone.apiBase,
    agentId: agentPhone.agentId,
    webhookSecret: agentPhone.webhookSecret,
  });
  return instance;
}

/** Override the Transport (used in tests / alternative providers). */
export function setTransport(t: Transport): void {
  instance = t;
}
