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
  /** Public base URL the device + install.sh point at (e.g. https://msg.example.com). */
  webhookBaseUrl: string;

  /** Server-side pepper mixed into device_token hashing. Never shipped to a device. */
  deviceTokenPepper: string;

  /**
   * Shared HMAC secret for dashboard SSE tickets. The dashboard (a separate app)
   * mints a short-TTL ticket with this same secret; the control plane verifies
   * it on GET /api/dashboard/events. OPTIONAL so the control plane still boots
   * before the secret is provisioned — the dashboard route fail-closes (no
   * secret → no valid ticket → 401) rather than crash-looping at boot.
   */
  sseTicketSecret: string | undefined;

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

/** Truthy env flag: "1"/"true"/"yes"/"on" (case-insensitive); anything else false. */
function isTruthy(name: string): boolean {
  const v = read(name);
  return v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * Pick the LLM backend the orchestrator talks to. `SHOULD_USE_CEREBRAS=true` is
 * the ergonomic toggle between the two backends wired in the LiteLLM proxy; an
 * explicit `LLM_MODEL` (any id) still wins as a power-user override. The result
 * MUST match a `model_name` in apps/litellm/config.yaml.
 */
function resolveLlmModel(): string {
  const explicit = read('LLM_MODEL');
  if (explicit) return explicit;
  if (isTruthy('SHOULD_USE_CEREBRAS')) return LLM_MODEL_CEREBRAS;
  return DEFAULT_LLM_MODEL;
}

const DEFAULT_PORT = 8080;
// Local-dev default: a LiteLLM proxy on localhost. A forgotten override fails as
// "proxy not running" (connection refused) rather than silently 404-ing a gemini
// model id against OpenAI. Prod sets LLM_API_BASE to the flycast proxy (fly.toml).
const DEFAULT_LLM_API_BASE = 'http://localhost:4000/v1';
// Backend model ids — each MUST match a `model_name` in apps/litellm/config.yaml.
const LLM_MODEL_GEMINI = 'gemini-3.5-flash';
const LLM_MODEL_CEREBRAS = 'gpt-oss-120b';
const DEFAULT_LLM_MODEL = LLM_MODEL_GEMINI;
// Local-dev default. Prod sets WEBHOOK_BASE_URL to the public control-plane
// origin (fly.toml [env]); never hardcode a specific deployment's host here.
const DEFAULT_WEBHOOK_BASE_URL = 'http://localhost:8080';

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
    sseTicketSecret: read('SSE_TICKET_SECRET'),
    agentPhone: {
      apiKey: read('AGENTPHONE_API_KEY'),
      apiBase: read('AGENTPHONE_API_BASE'),
      agentId: read('AGENTPHONE_AGENT_ID'),
      webhookSecret: read('AGENTPHONE_WEBHOOK_SECRET'),
    },
    llm: {
      apiKey: read('LLM_API_KEY'),
      apiBase: read('LLM_API_BASE') ?? DEFAULT_LLM_API_BASE,
      model: resolveLlmModel(),
    },
  };

  return cached;
}
