/**
 * LLM TURN ENGINE for the conversational assistant — the middleman between the
 * user and their Claude Code agents.
 *
 * The assistant runs a coding-agent-style TURN: triggered by an event (a user
 * text, or a coding-agent attention), it loops — calling tools and sending
 * messages via the `send_message` tool — until it emits a model turn with NO
 * tool calls (the turn is over). A per-turn round cap bounds runaway loops.
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
import { loadEnv } from '../env.ts';

/** An OpenAI-style tool call emitted by the model. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A chat message in the running turn transcript. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
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

/** Per-round network timeout (each model call within a turn). */
const REQUEST_TIMEOUT_MS = 20_000;
/** Sanity cap on tool-call rounds per turn (runaway guard, not a tight budget). */
const MAX_ROUNDS = 8;
/**
 * Conversational, not extraction: a little warmth for natural replies while
 * staying mostly deterministic for tool selection. Tunable.
 */
const ASSISTANT_TEMPERATURE = 0.3;

/** Outcome of running a turn (for logging). */
export interface TurnOutcome {
  rounds: number;
  toolCalls: number;
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
  execTool: ToolExecutor;
  /**
   * Called with terminal assistant text when the turn ends with prose instead
   * of a `send_message` call — a safety net so a stray final message is not
   * silently dropped. Only invoked when the turn produced no `send_message`.
   */
  onUnsentText?: (text: string) => Promise<void>;
}): Promise<TurnOutcome> {
  const { llm } = loadEnv();
  if (!llm.apiKey) {
    throw new Error('runAssistantTurn: LLM_API_KEY is not set');
  }

  const { messages, tools, user, execTool } = args;
  let toolCalls = 0;
  let sawSendMessage = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const msg = await callModel(llm, messages, tools, user);
    const calls = msg.tool_calls ?? [];

    if (calls.length === 0) {
      // Turn over. If the model ended with prose and never used send_message,
      // surface it so the user isn't left hanging (best-effort).
      const text = (msg.content ?? '').trim();
      if (text && !sawSendMessage && args.onUnsentText) {
        await args.onUnsentText(text);
      }
      return { rounds: round + 1, toolCalls };
    }

    // Record the assistant's tool-call turn BEFORE appending tool results.
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });

    for (const tc of calls) {
      toolCalls++;
      if (tc.function?.name === 'send_message') sawSendMessage = true;
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

/** One Chat Completions round. Throws on transport/HTTP error. */
async function callModel(
  llm: { apiBase: string; apiKey: string | undefined; model: string },
  messages: ReadonlyArray<ChatMessage>,
  tools: ReadonlyArray<ToolDef>,
  user: string,
): Promise<{ content?: string | null; tool_calls?: ToolCall[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${llm.apiBase.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: llm.model,
        temperature: ASSISTANT_TEMPERATURE,
        tools,
        tool_choice: 'auto',
        messages,
        user,
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
  }
}
