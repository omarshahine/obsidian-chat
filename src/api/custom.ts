import { requestUrl } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ContentBlock,
} from "../types";

/**
 * Sends a message to any OpenAI Chat Completions-compatible API (DeepSeek,
 * Ollama, Together, OpenRouter, etc.) via requestUrl().
 *
 * This adapter uses the /v1/chat/completions endpoint with function calling,
 * which is the most widely supported format across third-party providers.
 */
export async function sendCustomMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string
): Promise<UnifiedResponse> {
  const baseUrl = (settings.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
  const model = settings.model || "deepseek-chat";

  const apiMessages: Record<string, unknown>[] = [];

  // System prompt as the first message
  if (systemPrompt) {
    apiMessages.push({ role: "system", content: systemPrompt });
  }

  // Convert unified messages to OpenAI Chat Completions format
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      apiMessages.push({ role: msg.role, content: msg.content });
    } else {
      // Content blocks: tool_use (assistant) and tool_result (user)
      const textParts: string[] = [];
      const toolCalls: Record<string, unknown>[] = [];

      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        } else if (block.type === "tool_result") {
          apiMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: block.content || "",
          });
        }
      }

      if (msg.role === "assistant") {
        const hasText = textParts.length > 0;
        const hasToolCalls = toolCalls.length > 0;
        // Skip fully empty assistant turns. Emitting { content: null } with no
        // tool_calls is rejected by some OpenAI-compatible servers; when tool
        // calls are present we send "" rather than null for broad compatibility.
        if (hasText || hasToolCalls) {
          const entry: Record<string, unknown> = {
            role: "assistant",
            content: hasText ? textParts.join("") : "",
          };
          if (hasToolCalls) {
            entry.tool_calls = toolCalls;
          }
          apiMessages.push(entry);
        }
      } else if (textParts.length > 0) {
        apiMessages.push({ role: "user", content: textParts.join("") });
      }
    }
  }

  const body: Record<string, unknown> = {
    model,
    messages: apiMessages,
    stream: false,
  };

  // Tools as OpenAI function calling format
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  let response;
  try {
    response = await requestUrl({
      url: `${baseUrl}/v1/chat/completions`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e: unknown) {
    const err = e as Record<string, unknown>;
    const apiMsg = (err.json as { error?: { message?: string } })?.error?.message;
    if (apiMsg) {
      throw new Error(`API error: ${apiMsg}`);
    }
    throw new Error(`Request failed: ${err.message || String(e)}`);
  }

  if (response.status !== 200) {
    const errorBody = response.json?.error?.message || `HTTP ${response.status}`;
    throw new Error(`API error (${response.status}): ${errorBody}`);
  }

  const data = response.json;
  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error("No response from API");
  }

  const content: ContentBlock[] = [];

  // Extract text content
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  // Extract tool/function calls
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = { _raw: tc.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  const hasToolCalls = content.some((b) => b.type === "tool_use");
  const stopReason = hasToolCalls ? "tool_use" : "end_turn";

  return {
    content,
    stopReason,
    usage: data.usage
      ? {
          inputTokens: data.usage.prompt_tokens || 0,
          outputTokens: data.usage.completion_tokens || 0,
        }
      : undefined,
  };
}
