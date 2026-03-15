import type { ChatSettings, UnifiedMessage, UnifiedToolDef, UnifiedResponse } from "../types";
import { sendAnthropicMessage } from "./anthropic";
import { sendOpenAIMessage } from "./openai";

/**
 * Dispatches a message to the appropriate provider adapter.
 * Handles single retry on 429 (rate limit) with exponential backoff.
 */
export async function sendMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string
): Promise<UnifiedResponse> {
  const doSend = () => {
    if (settings.provider === "anthropic") {
      return sendAnthropicMessage(settings, messages, tools, systemPrompt);
    }
    return sendOpenAIMessage(settings, messages, tools, systemPrompt);
  };

  try {
    return await doSend();
  } catch (e) {
    // Single retry on rate limit
    if (isRateLimitError(e)) {
      const retryAfter = extractRetryAfter(e);
      const delay = retryAfter ? retryAfter * 1000 : 5000;
      await sleep(Math.min(delay, 30000));
      return await doSend();
    }
    throw e;
  }
}

function isRateLimitError(e: unknown): boolean {
  if (e instanceof Error) {
    return e.message.includes("429") || e.message.toLowerCase().includes("rate limit");
  }
  return false;
}

function extractRetryAfter(e: unknown): number | null {
  if (e instanceof Error) {
    const match = e.message.match(/retry.after[:\s]*(\d+)/i);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
