/**
 * Minimal LLM abstraction (llmComplete).
 *
 * OpenAI-compatible Chat Completions by default (env LLM_API_BASE / LLM_MODEL /
 * LLM_API_KEY). Kept deliberately tiny and provider-agnostic so the orchestrator
 * depends on a single `llmComplete()` call, not an SDK. We request a JSON object
 * response and parse it; the orchestrator validates the parsed shape.
 *
 * Fail-closed: if no API key is configured, llmComplete throws — the
 * orchestrator catches that and falls back to a safe clarify, never an allow.
 */
import { loadEnv } from '../env.ts';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Complete a chat and return the raw assistant text. Requests a JSON object
 * response (response_format) so the orchestrator can parse a structured action.
 */
export async function llmComplete(
  messages: ReadonlyArray<LlmMessage>,
): Promise<string> {
  const { llm } = loadEnv();
  if (!llm.apiKey) {
    throw new Error('llmComplete: LLM_API_KEY is not set');
  }

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
        // Deterministic structured output: temperature 0 (run-to-run stability).
        temperature: 0,
        response_format: { type: 'json_object' },
        messages,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`llmComplete failed: ${res.status} ${res.statusText} ${detail}`);
    }

    const json = (await res.json()) as ChatCompletionResponse;
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('llmComplete: empty completion');
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a JSON object from an LLM completion, tolerating ```json fences. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(unfenced) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
