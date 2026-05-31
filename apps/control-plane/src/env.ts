/**
 * Typed environment contract for the control plane.
 *
 * The app tier is stateless; every secret/config arrives via env (12-factor).
 * We read once at boot and surface a single typed object. Missing-but-required
 * values fail LOUD at boot rather than silently at request time.
 */

/** All control-plane configuration, derived once from process.env. */
export interface ControlPlaneEnv {
  /** Neon Postgres connection string. */
  databaseUrl: string;
  /** Port the HTTP server binds. */
  port: number;
  /** Public base URL the device + install.sh point at (e.g. https://message.prbe.ai). */
  webhookBaseUrl: string;

  /** Server-side pepper mixed into device_token hashing. Never shipped to a device. */
  deviceTokenPepper: string;

  /** AgentPhone transport config (also read by @imsg/transport from env). */
  agentPhone: {
    apiKey: string | undefined;
    apiBase: string | undefined;
    agentId: string | undefined;
    webhookSecret: string | undefined;
  };

  /** LLM (orchestrator) config — OpenAI-compatible chat completions by default. */
  llm: {
    apiKey: string | undefined;
    apiBase: string;
    model: string;
  };
}

function read(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function require_(name: string): string {
  const v = read(name);
  if (v === undefined) {
    throw new Error(`control-plane: required env ${name} is not set`);
  }
  return v;
}

const DEFAULT_PORT = 8080;
const DEFAULT_LLM_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_LLM_MODEL = 'gpt-4o-mini';
const DEFAULT_WEBHOOK_BASE_URL = 'https://message.prbe.ai';

let cached: ControlPlaneEnv | undefined;

/** Load (and memoize) the validated environment. Throws on missing requireds. */
export function loadEnv(): ControlPlaneEnv {
  if (cached) return cached;

  const portRaw = read('PORT');
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`control-plane: invalid PORT "${portRaw}"`);
  }

  cached = {
    databaseUrl: require_('DATABASE_URL'),
    port,
    webhookBaseUrl: read('WEBHOOK_BASE_URL') ?? DEFAULT_WEBHOOK_BASE_URL,
    // Device token hashing MUST be peppered; a missing pepper is a security
    // misconfiguration, so we fail closed at boot.
    deviceTokenPepper: require_('DEVICE_TOKEN_PEPPER'),
    agentPhone: {
      apiKey: read('AGENTPHONE_API_KEY'),
      apiBase: read('AGENTPHONE_API_BASE'),
      agentId: read('AGENTPHONE_AGENT_ID'),
      webhookSecret: read('AGENTPHONE_WEBHOOK_SECRET'),
    },
    llm: {
      apiKey: read('LLM_API_KEY'),
      apiBase: read('LLM_API_BASE') ?? DEFAULT_LLM_API_BASE,
      model: read('LLM_MODEL') ?? DEFAULT_LLM_MODEL,
    },
  };

  return cached;
}
