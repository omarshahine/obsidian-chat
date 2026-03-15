import { requestUrl } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ContentBlock,
} from "../types";

const DEFAULT_OPENAI_URL = "https://api.openai.com";

/**
 * Stores raw output items from each API response so they can be replayed
 * verbatim in subsequent requests. The Responses API requires exact
 * function_call items (with all fields) when sending function_call_output.
 */
let previousResponseId: string | null = null;

/** Clear stored state (call on conversation clear) */
export function clearOpenAIState(): void {
  previousResponseId = null;
}

/**
 * Sends a message to OpenAI via the Responses API (/v1/responses).
 * Uses the `previous_response_id` field for multi-turn, which lets
 * OpenAI manage conversation state server-side and avoids us having to
 * reconstruct function_call items.
 */
export async function sendOpenAIMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string
): Promise<UnifiedResponse> {
  const baseUrl = DEFAULT_OPENAI_URL;
  const model = settings.model || "gpt-5.3-codex";

  // Build input: only the NEW items for this turn
  const input = buildCurrentTurnInput(messages, systemPrompt);

  const body: Record<string, unknown> = {
    model,
    input,
  };

  // Chain to previous response for multi-turn context
  if (previousResponseId) {
    body.previous_response_id = previousResponseId;
  }

  // Reasoning for reasoning-capable models
  if (/^o\d/.test(model) || /^gpt-5/.test(model)) {
    body.reasoning = { effort: "medium" };
  }

  // Tools
  const apiTools: Record<string, unknown>[] = tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));

  if (settings.enableWebSearch) {
    apiTools.push({ type: "web_search_preview" });
  }

  if (apiTools.length > 0) {
    body.tools = apiTools;
  }

  // Always send instructions (system prompt) since previous_response_id
  // doesn't carry forward the system prompt
  body.instructions = systemPrompt;

  let response;
  try {
    response = await requestUrl({
      url: `${baseUrl}/v1/responses`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e: unknown) {
    const err = e as Record<string, unknown>;
    const apiMsg = (err.json as { error?: { message?: string } })?.error?.message;
    if (apiMsg) {
      throw new Error(`OpenAI API error (${err.status}): ${apiMsg}`);
    }
    throw new Error(`OpenAI request failed (${err.status || ""}): ${err.message || String(e)}`);
  }

  if (response.status !== 200) {
    const errorBody = response.json?.error?.message || `HTTP ${response.status}`;
    throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
  }

  const data = response.json;

  // Store response ID for chaining
  previousResponseId = data.id || null;

  return fromResponsesOutput(data);
}

// ─── Input Building ─────────────────────────────────────────────────────────

/**
 * Builds input items for the current turn only.
 * When using previous_response_id, we only need to send:
 * - On first call: system message + user message
 * - On tool result calls: function_call_output items
 * - On follow-up user messages: user message
 */
function buildCurrentTurnInput(
  messages: UnifiedMessage[],
  systemPrompt: string
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];

  // If no previous response (first call), include all messages
  if (!previousResponseId) {
    items.push({
      type: "message",
      role: "developer",
      content: systemPrompt,
    });

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        items.push({
          type: "message",
          role: msg.role === "assistant" ? "assistant" : "user",
          content: msg.content,
        });
      }
    }
    return items;
  }

  // For subsequent calls, only send the latest turn's items
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg) return items;

  if (typeof lastMsg.content === "string") {
    items.push({
      type: "message",
      role: "user",
      content: lastMsg.content,
    });
    return items;
  }

  // Tool results
  const toolResults = lastMsg.content.filter((b) => b.type === "tool_result");
  if (toolResults.length > 0) {
    for (const tr of toolResults) {
      items.push({
        type: "function_call_output",
        call_id: tr.tool_use_id,
        output: tr.content || "",
      });
    }
    return items;
  }

  // Text content
  const text = lastMsg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (text) {
    items.push({
      type: "message",
      role: lastMsg.role === "assistant" ? "assistant" : "user",
      content: text,
    });
  }

  return items;
}

// ─── Response Parsing ───────────────────────────────────────────────────────

function fromResponsesOutput(data: Record<string, unknown>): UnifiedResponse {
  const output = (data.output || []) as Array<Record<string, unknown>>;
  const content: ContentBlock[] = [];
  let hasToolCalls = false;

  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content as Array<Record<string, unknown>>) {
        if (part.type === "output_text" && typeof part.text === "string") {
          content.push({ type: "text", text: part.text });
        }
      }
    } else if (item.type === "function_call") {
      hasToolCalls = true;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse((item.arguments as string) || "{}");
      } catch {
        input = { _raw: item.arguments };
      }
      content.push({
        type: "tool_use",
        id: (item.call_id || item.id) as string,
        name: item.name as string,
        input,
      });
    }
  }

  const stopReason = hasToolCalls ? "tool_use" : "end_turn";
  const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;

  return {
    content,
    stopReason,
    usage: usage
      ? { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 }
      : undefined,
  };
}
