// ─── Settings ───────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "custom";

export interface ChatSettings {
  provider: Provider;
  apiKey: string;
  model: string;
  maxIterations: number;
  enableWebSearch: boolean;
  baseUrl: string;
}

export const DEFAULT_SETTINGS: ChatSettings = {
  provider: "anthropic",
  apiKey: "",
  model: "claude-sonnet-4-6",
  maxIterations: 20,
  enableWebSearch: true,
  baseUrl: "",
};

// ─── Unified Message Format ─────────────────────────────────────────────────

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface UnifiedMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export interface UnifiedToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── API Response ───────────────────────────────────────────────────────────

export interface UnifiedResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop" | string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ─── Conversation Context ───────────────────────────────────────────────────

export interface ConversationContext {
  activeFile: string | null;
  activeFileContent: string | null;
  selection: string | null;
  vaultName: string;
  fileCount: number;
}

// ─── Selection Scope ────────────────────────────────────────────────────────

export interface SelectionScope {
  /** The selected text */
  text: string;
  /** Path to the file containing the selection */
  filePath: string;
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

export interface ToolResult {
  result: string;
  isError: boolean;
}

// ─── Agent Loop Callbacks ───────────────────────────────────────────────────

export interface AgentCallbacks {
  onThinking: () => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: ToolResult) => void;
  onResponse: (text: string) => void;
  onAskUser: (question: string) => Promise<string>;
  onError: (error: string) => void;
}

// ─── Chat Sessions ──────────────────────────────────────────────────────────

/**
 * One rendered entry in a session's transcript. This is the UI-facing
 * history, replayed into the view when a session is opened; the API-facing
 * history lives separately in `AgentLoop`.
 */
export interface ChatHistoryEntry {
  type: string;
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: ToolResult;
}

/**
 * Per-conversation OpenAI Responses API state.
 *
 * The Responses API threads multi-turn context server-side via
 * `previous_response_id`, so this MUST be per session. It used to be a
 * module-level singleton in `api/openai.ts`, which meant a second session
 * would send the first session's response id and OpenAI would splice the
 * wrong conversation in — the exact cross-session bleed sessions exist to
 * prevent, and invisible from the UI.
 */
export interface OpenAIConversationState {
  previousResponseId: string | null;
}

/** A session as persisted to disk. */
export interface SessionSnapshot {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  chatHistory: ChatHistoryEntry[];
  agentMessages: UnifiedMessage[];
  openai: OpenAIConversationState;
}

/** Shape of `chat-state.json` since multi-session support. */
export interface PersistedChatState {
  version: 2;
  activeSessionId: string | null;
  sessions: SessionSnapshot[];
}
