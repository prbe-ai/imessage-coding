/**
 * LLM TURN ENGINE for the conversational assistant — the middleman between the
 * user and their Claude Code agents.
 *
 * The assistant runs a coding-agent-style TURN: triggered by an event (a user
 * text, a coding-agent attention, or a coding-agent status message), it loops —
 * calling tools and sending messages via the `message_user` tool — until it emits
 * a model turn with NO tool calls (the turn is over). A per-turn round cap bounds runaway loops.
 *
 * Transport is OpenAI-compatible tool-calling Chat Completions over env
 * LLM_API_BASE / LLM_MODEL / LLM_API_KEY — in production a private LiteLLM proxy
 * serving Gemini. EVERY request carries the OpenAI `user` field (the account id)
 * so the proxy attributes per-iMessage-user spend.
 *
 * Fail-closed: if no API key is configured, the turn throws — the caller turns
 * that into a safe outcome (a clarify text to the user, or the static fallback
 * notification on the agent-event path), never an unsafe action.
 */
import { ToolName } from '@imsg/shared';
import { loadEnv } from '../env.ts';

/** An OpenAI-style tool call emitted by the model. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A single OpenAI content part. Text parts carry prose; image parts carry an
 *  `image_url.url` that is either a remote URL or a `data:<mime>;base64,<…>` URI
 *  (we always send the latter — see orchestrator/media.ts). Only multimodal
 *  backends (gemini-3.5-flash) interpret image parts; text-only ones ignore them. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** A chat message in the running turn transcript. `content` is a plain string for
 *  text-only messages, or an array of content parts when the turn carries images. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** An OpenAI-style function tool definition advertised to the model. */
export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Execute one tool call and return a short result string fed back to the model.
 * Implementations must NOT throw for expected failures — return an `error: …`
 * string so the model can recover within the turn.
 */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }>;
}

/** Per-round network timeout (each model call within a turn). gpt-oss-120b is a
 *  reasoning model whose tail latency occasionally runs past the old 20s cap; a
 *  slow-but-healthy response was then aborted and surfaced to the user as the
 *  fail-closed "trouble reaching my brain" clarify (observed failures clustered at
 *  24-26s). 110s gives the reasoning tail ample room.
 *
 *  CEILING: this MUST stay below LEASE_TTL_SECONDS (120s, account-lock.ts). The
 *  per-account cross-machine lease is a NON-renewed TTL row; a turn that holds it
 *  past the TTL lets another Fly machine steal the lease and double-act the same
 *  account. A single round capped under the TTL cannot breach it. Raising this at
 *  or above 120s requires raising the lease TTL + acquire window, or adding lease
 *  renewal — do not bump it in isolation. */
const REQUEST_TIMEOUT_MS = 110_000;
/** Sanity cap on tool-call rounds per turn (runaway guard, not a tight budget). */
const MAX_ROUNDS = 8;
/**
 * Conversational, not extraction: a little warmth for natural replies while
 * staying mostly deterministic for tool selection. Tunable.
 */
const ASSISTANT_TEMPERATURE = 0.3;

/** Result of running a turn loop — round/tool-call counts, for logging. */
export interface TurnRunResult {
  rounds: number;
  toolCalls: number;
  /**
   * True when an external `signal` interrupted the turn BEFORE it committed any
   * side effect (nothing sent, no action taken). The turn delivered nothing, so
   * the caller must NOT fire a fallback message — it re-runs a fresh combined
   * turn instead (back-to-back inbound coalescing). Never set once committed.
   */
  aborted?: boolean;
}

/**
 * Drive one assistant turn to completion. Mutates `messages` in place with the
 * assistant/tool exchange. Side effects (messages sent, attentions resolved)
 * happen through `execTool`. Returns when the model stops calling tools or the
 * round cap is hit.
 */
export async function runAssistantTurn(args: {
  messages: ChatMessage[];
  tools: ReadonlyArray<ToolDef>;
  /** OpenAI `user` field — the account id, for per-user spend attribution. */
  user: string;
  /**
   * Optional per-request `metadata` forwarded verbatim in the chat body. The
   * LiteLLM proxy reads Langfuse-recognized keys here (trace_id, trace_name,
   * session_id, trace_user_id, tags) so the whole multi-round turn collapses to
   * ONE trace instead of N disconnected per-round traces. Ignored when the proxy
   * has no Langfuse callback configured (it's just an extra body field).
   */
  metadata?: Record<string, unknown>;
  execTool: ToolExecutor;
  /**
   * Called with terminal assistant text when the turn ends with prose instead
   * of a `message_user` call — a safety net so a stray final message is not
   * silently dropped. Only invoked when the turn produced no `message_user`.
   */
  onUnsentText?: (text: string) => Promise<void>;
  /**
   * Cooperative interrupt. While the turn is still UNCOMMITTED (waiting on the
   * model), an abort stops the loop and returns `{ aborted: true }` without
   * sending — the caller coalesces a freshly-arrived inbound into one combined
   * turn. The interrupt also aborts the in-flight LLM request. Once the turn
   * COMMITS a side effect (see `commit`) the signal is ignored: a committed
   * turn always finishes, so we never half-apply a tool call.
   */
  signal?: AbortSignal;
  /**
   * Commit latch shared with the caller. Set `committed = true` synchronously,
   * before the first side-effecting `await` (a tool call, or terminal prose).
   * The caller reads it to decide whether a newly-arrived inbound may interrupt
   * this turn — only while still uncommitted. Defaults to a private latch.
   */
  commit?: { committed: boolean };
  /**
   * Per-turn model override — a `model_name` from the LiteLLM config. Defaults to
   * env `LLM_MODEL`. The caller forces the vision-capable backend
   * (gemini-3.5-flash) for image turns even when the text default is a text-only
   * model (Cerebras gpt-oss-120b can't see images).
   */
  model?: string;
}): Promise<TurnRunResult> {
  const { llm } = loadEnv();
  if (!llm.apiKey) {
    throw new Error('runAssistantTurn: LLM_API_KEY is not set');
  }

  const { messages, tools, user, execTool, signal } = args;
  const model = args.model ?? llm.model;
  const commit = args.commit ?? { committed: false };
  let toolCalls = 0;
  let sawMessageUser = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Interrupt point — only reachable while uncommitted (no side effect yet).
    if (signal?.aborted) return { rounds: round, toolCalls, aborted: true };

    let msg: { content?: string | null; tool_calls?: ToolCall[] };
    try {
      msg = await callModel(llm, model, messages, tools, user, signal, args.metadata);
    } catch (err) {
      // A fetch rejection WHILE interrupted is a clean coalesce, not an error:
      // swallow it (don't let the caller fire its fail-closed clarify text).
      if (signal?.aborted) return { rounds: round, toolCalls, aborted: true };
      throw err;
    }
    // The model may have returned just as an interrupt landed — bail before
    // committing this round's side effects.
    if (signal?.aborted) return { rounds: round, toolCalls, aborted: true };

    const calls = msg.tool_calls ?? [];

    if (calls.length === 0) {
      // Turn over. If the model ended with prose and never used message_user,
      // surface it so the user isn't left hanging (best-effort).
      const text = (msg.content ?? '').trim();
      if (text && !sawMessageUser && args.onUnsentText) {
        // COMMIT before the first (and only) side-effecting await on this path.
        commit.committed = true;
        await args.onUnsentText(text);
      }
      return { rounds: round + 1, toolCalls };
    }

    // COMMIT before running any tool call — from here the turn always finishes.
    commit.committed = true;

    // Record the assistant's tool-call turn BEFORE appending tool results.
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });

    for (const tc of calls) {
      toolCalls++;
      if (tc.function?.name === ToolName.MESSAGE_USER) sawMessageUser = true;
      let result: string;
      try {
        const parsed =
          tc.function?.arguments && tc.function.arguments.trim()
            ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
            : {};
        result = await execTool(tc.function.name, parsed);
      } catch (err) {
        result = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  // Round cap reached — end the turn. Side effects so far already happened.
  return { rounds: MAX_ROUNDS, toolCalls };
}

/** One Chat Completions round. Throws on transport/HTTP error.
 *  `external` is the turn's interrupt signal — when it aborts (a new inbound
 *  arrived mid-round), we abort the in-flight request too so the coalesced turn
 *  doesn't wait out a stale round. */
async function callModel(
  llm: { apiBase: string; apiKey: string | undefined; model: string },
  model: string,
  messages: ReadonlyArray<ChatMessage>,
  tools: ReadonlyArray<ToolDef>,
  user: string,
  external?: AbortSignal,
  metadata?: Record<string, unknown>,
): Promise<{ content?: string | null; tool_calls?: ToolCall[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // Chain the external interrupt onto this request's controller (the timeout and
  // the interrupt both abort the same fetch). Listener removed in finally.
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(`${llm.apiBase.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: ASSISTANT_TEMPERATURE,
        tools,
        tool_choice: 'auto',
        messages,
        user,
        ...(metadata ? { metadata } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`chatCompletion failed: ${res.status} ${res.statusText} ${detail}`);
    }

    const json = (await res.json()) as ChatCompletionResponse;
    const msg = json.choices?.[0]?.message;
    if (!msg) {
      throw new Error('chatCompletion: empty choices');
    }
    return msg;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}
