import { App } from "obsidian";
import type {
  ChatSettings,
  ChatHistoryEntry,
  SessionSnapshot,
  PersistedChatState,
} from "./types";
import { AgentLoop } from "./agent/loop";

/** Cap on UI transcript entries kept per session when persisting. */
const MAX_HISTORY_PER_SESSION = 100;
/** Cap on API messages kept per session when persisting. */
const MAX_AGENT_MESSAGES_PER_SESSION = 80;
/**
 * Cap on retained sessions. Sessions are never deleted from the UI, so
 * without a bound `chat-state.json` would grow forever. Least-recently-used
 * sessions are evicted first; the active session is never evicted.
 */
const MAX_SESSIONS = 20;

/** Longest auto-derived title before ellipsis. */
const MAX_TITLE_LENGTH = 40;

const UNTITLED = "New chat";

/**
 * One conversation: its own transcript, its own AgentLoop (and therefore its
 * own API message history and provider chaining state).
 */
export class ChatSession {
  readonly id: string;
  title: string;
  readonly createdAt: number;
  updatedAt: number;
  chatHistory: ChatHistoryEntry[] = [];
  readonly agent: AgentLoop;

  constructor(app: App, settings: ChatSettings, id?: string, createdAt?: number) {
    this.id = id ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.createdAt = createdAt ?? Date.now();
    this.updatedAt = this.createdAt;
    this.title = UNTITLED;
    this.agent = new AgentLoop(app, settings);
  }

  /** True until the session has any transcript content. */
  get isEmpty(): boolean {
    return this.chatHistory.length === 0;
  }

  /**
   * Title the session from its first user message, once. Titles are derived
   * rather than model-generated so that opening a chat never costs a call.
   */
  maybeTitleFrom(text: string): void {
    if (this.title !== UNTITLED) return;
    const flat = text.replace(/\s+/g, " ").trim();
    if (!flat) return;
    this.title =
      flat.length > MAX_TITLE_LENGTH ? `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…` : flat;
  }

  touch(): void {
    this.updatedAt = Date.now();
  }

  toSnapshot(): SessionSnapshot {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      chatHistory: this.chatHistory.slice(-MAX_HISTORY_PER_SESSION),
      agentMessages: this.agent.exportMessages().slice(-MAX_AGENT_MESSAGES_PER_SESSION),
      openai: this.agent.exportOpenAIState(),
    };
  }

  static fromSnapshot(app: App, settings: ChatSettings, snap: SessionSnapshot): ChatSession {
    const session = new ChatSession(app, settings, snap.id, snap.createdAt);
    session.title = snap.title || UNTITLED;
    session.updatedAt = snap.updatedAt ?? snap.createdAt ?? Date.now();
    session.chatHistory = Array.isArray(snap.chatHistory) ? snap.chatHistory : [];
    if (Array.isArray(snap.agentMessages)) {
      session.agent.importMessages(snap.agentMessages);
    }
    session.agent.importOpenAIState(snap.openai);
    return session;
  }
}

/**
 * Holds every open conversation and which one the view is showing.
 *
 * Sessions are deliberately not scoped to a note — the plugin's reach across
 * the whole vault is the point, and a session that followed the active file
 * would undo that.
 */
export class SessionStore {
  private sessions: ChatSession[] = [];
  private activeId: string | null = null;

  constructor(
    private app: App,
    private settings: ChatSettings
  ) {}

  /** Every session, most recently used first. */
  list(): ChatSession[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get count(): number {
    return this.sessions.length;
  }

  /** The active session, creating the first one on demand. */
  active(): ChatSession {
    const found = this.sessions.find((s) => s.id === this.activeId);
    if (found) return found;
    if (this.sessions.length > 0) {
      const fallback = this.list()[0];
      this.activeId = fallback.id;
      return fallback;
    }
    return this.create();
  }

  get(id: string): ChatSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** Start a new session and make it active. */
  create(): ChatSession {
    const session = new ChatSession(this.app, this.settings);
    this.sessions.push(session);
    this.activeId = session.id;
    this.evict();
    return session;
  }

  /**
   * Reuse the active session when it is still untouched rather than stacking
   * up blank chats. "New chat" pressed twice in a row should not leave an
   * empty session behind.
   */
  createOrReuseEmpty(): ChatSession {
    const current = this.sessions.find((s) => s.id === this.activeId);
    if (current && current.isEmpty) return current;
    return this.create();
  }

  setActive(id: string): ChatSession | undefined {
    const session = this.get(id);
    if (session) this.activeId = id;
    return session;
  }

  /** Drop least-recently-used sessions past the cap, never the active one. */
  private evict(): void {
    if (this.sessions.length <= MAX_SESSIONS) return;
    const keep = new Set(
      this.list()
        .slice(0, MAX_SESSIONS)
        .map((s) => s.id)
    );
    if (this.activeId) keep.add(this.activeId);
    this.sessions = this.sessions.filter((s) => keep.has(s.id));
  }

  toPersisted(): PersistedChatState {
    return {
      version: 2,
      activeSessionId: this.activeId,
      sessions: this.list().map((s) => s.toSnapshot()),
    };
  }

  /**
   * Restore from disk. Accepts the pre-multi-session shape
   * (`{ chatHistory, agentMessages }`) and migrates it into a single session,
   * so an upgrade never loses the conversation in progress.
   */
  restore(raw: unknown): void {
    this.sessions = [];
    this.activeId = null;
    if (!raw || typeof raw !== "object") return;
    const state = raw as Partial<PersistedChatState> & {
      chatHistory?: ChatHistoryEntry[];
      agentMessages?: SessionSnapshot["agentMessages"];
    };

    if (Array.isArray(state.sessions)) {
      for (const snap of state.sessions) {
        if (!snap || typeof snap.id !== "string") continue;
        this.sessions.push(ChatSession.fromSnapshot(this.app, this.settings, snap));
      }
      if (state.activeSessionId && this.get(state.activeSessionId)) {
        this.activeId = state.activeSessionId;
      }
      this.evict();
      return;
    }

    // v1: a single unnamed conversation.
    if (Array.isArray(state.chatHistory) || Array.isArray(state.agentMessages)) {
      const session = new ChatSession(this.app, this.settings);
      session.chatHistory = Array.isArray(state.chatHistory) ? state.chatHistory : [];
      if (Array.isArray(state.agentMessages)) {
        session.agent.importMessages(state.agentMessages);
      }
      const firstUser = session.chatHistory.find((m) => m.type === "user" && m.text);
      if (firstUser?.text) session.maybeTitleFrom(firstUser.text);
      this.sessions.push(session);
      this.activeId = session.id;
    }
  }
}
