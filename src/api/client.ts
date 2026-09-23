import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  OpenAIConversationState,
} from "../types";
import { sendAnthropicMessage } from "./anthropic";
import { sendOpenAIMessage, clearOpenAIState } from "./openai";
import { sendCustomMessage } from "./custom";

/**
 * Dispatches a message to the appropriate provider adapter.
 * Handles single retry on 429 (rate limit) with exponential backoff.
 */
export async function sendMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string,
  openaiState: OpenAIConversationState
): Promise<UnifiedResponse> {
  // An OpenAI chain only holds the turns that went through it. Once a turn goes
  // to another provider, chaining past it would send OpenAI just the newest
  // message, so drop the chain and let the next OpenAI call resend history.
  if (settings.provider === "anthropic" || settings.provider === "custom") {
    clearOpenAIState(openaiState);
  }

  const doSend = () => {
    if (settings.provider === "anthropic") {
      return sendAnthropicMessage(settings, messages, tools, systemPrompt);
    }
    if (settings.provider === "custom") {
      return sendCustomMessage(settings, messages, tools, systemPrompt);
    }
    return sendOpenAIMessage(settings, messages, tools, systemPrompt, openaiState);
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
