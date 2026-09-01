import {
  Plugin,
  Platform,
  Notice,
  type MarkdownFileInfo,
  type Editor,
  Menu,
  TFile,
  type TAbstractFile,
} from "obsidian";
import type { ChatSettings, SelectionScope } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { ChatSettingTab, getModelDisplayName } from "./settings";
import { ObsidianChatView, VIEW_TYPE_CHAT } from "./ui/chat-view";
import { SessionStore } from "./sessions";

export default class ChatPlugin extends Plugin {
  settings: ChatSettings = DEFAULT_SETTINGS;
  /**
   * Every open conversation. Each session owns its own AgentLoop, so
   * switching chats swaps the agent state too rather than replaying one
   * history through a shared loop.
   */
  sessions!: SessionStore;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.sessions = new SessionStore(this.app, this.settings);

    // Restore persisted chat history
    await this.loadChatHistory();

    this.addSettingTab(new ChatSettingTab(this.app, this));

    // Register sidebar view (loads deferred by default in v1.7.2+)
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ObsidianChatView(leaf, this));

    // Ribbon icon (users can hide; commands are the primary access)
    this.addRibbonIcon("message-circle", "Open Obsidian Chat", (evt) => {
      if (evt.type === "contextmenu" || (evt instanceof MouseEvent && evt.button === 2)) {
        // Right-click: show menu with options
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Open chat").setIcon("message-circle").onClick(() => this.openChat())
        );
        menu.addItem((item) =>
          item.setTitle("New chat").setIcon("plus").onClick(() => this.newChat())
        );
        menu.addItem((item) =>
          item.setTitle("Chat about active note").setIcon("file-text").onClick(() => this.chatAboutActiveNote())
        );
        menu.addItem((item) =>
          item.setTitle("Copy transcript").setIcon("clipboard").onClick(() => this.shareTranscript())
        );
        menu.showAtMouseEvent(evt as MouseEvent);
      } else {
        this.openChat();
      }
    });

    // ─── Commands ────────────────────────────────────────────────────────

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.openChat(),
    });

    this.addCommand({
      id: "copy-transcript",
      name: "Copy conversation transcript to clipboard",
      callback: () => this.shareTranscript(),
    });

    this.addCommand({
      id: "clear-chat",
      name: "Clear conversation",
      callback: () => this.clearChat(),
    });

    this.addCommand({
      id: "new-chat",
      name: "New chat",
      callback: () => this.newChat(),
    });

    // Editor command: chat about the current note (only when editor is active)
    this.addCommand({
      id: "chat-about-note",
      name: "Chat about this note",
      editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
        this.openChatWithMessage(`Summarize this note: ${ctx.file?.path ?? "the active document"}`);
      },
    });

    // Editor command: chat about selected text (conditional, only when text is selected)
    this.addCommand({
      id: "send-selection",
      name: "Send selection to Chat",
      editorCheckCallback: (checking: boolean, editor: Editor, ctx: MarkdownFileInfo) => {
        const sel = editor.getSelection();
        if (!sel || sel.length === 0) return false;
        if (checking) return true;
        const scope: SelectionScope = { text: sel, filePath: ctx.file?.path ?? "" };
        this.openChatWithSelection(scope);
        return true;
      },
    });

    // ─── Context menus ──────────────────────────────────────────────────

    // File explorer context menu
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Chat about this note")
            .setIcon("message-circle")
            .onClick(() => this.openChatWithMessage(`Tell me about ${file.path}`))
        );
      })
    );

    // Editor right-click context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownFileInfo) => {
        const sel = editor.getSelection();
        if (sel && sel.length > 0) {
          menu.addItem((item) =>
            item
              .setTitle("Send selection to Chat")
              .setIcon("message-circle")
              .onClick(() => {
                const scope: SelectionScope = { text: sel, filePath: info.file?.path ?? "" };
                this.openChatWithSelection(scope);
              })
          );
        }
      })
    );
  }

  async onunload(): Promise<void> {
    for (const session of this.sessions.list()) session.agent.abort();
    await this.saveChatHistory();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
  }

  // ─── Chat operations ────────────────────────────────────────────────

  private async openChat(): Promise<void> {
    if (!this.settings.apiKey) {
      new Notice("Please configure your API key in Obsidian Chat settings.");
      return;
    }
    await this.activateView();
  }

  /**
   * Open chat and immediately send a message, in a fresh session.
   *
   * Note-driven entry points start their own conversation rather than
   * appending to whatever was already open — asking about a note should not
   * hijack an unrelated thread in progress.
   */
  private async openChatWithMessage(message: string): Promise<void> {
    if (!this.settings.apiKey) {
      new Notice("Please configure your API key in Obsidian Chat settings.");
      return;
    }
    this.sessions.createOrReuseEmpty();
    await this.activateView();
    const view = this.getChatView();
    if (view) {
      view.renderActiveSession();
      setTimeout(() => view.sendMessage(message), 100);
    }
  }

  /** Open chat with a selection scope (shows pill, user types their own question) */
  private async openChatWithSelection(selection: SelectionScope): Promise<void> {
    if (!this.settings.apiKey) {
      new Notice("Please configure your API key in Obsidian Chat settings.");
      return;
    }
    this.sessions.createOrReuseEmpty();
    await this.activateView();
    const view = this.getChatView();
    if (view) {
      view.renderActiveSession();
      setTimeout(() => {
        view.setSelection(selection);
        view.focus();
      }, 100);
    }
  }

  /** Start a new conversation and show it, leaving existing ones intact. */
  async newChat(): Promise<void> {
    if (!this.settings.apiKey) {
      new Notice("Please configure your API key in Obsidian Chat settings.");
      return;
    }
    this.sessions.createOrReuseEmpty();
    await this.activateView();
    this.getChatView()?.renderActiveSession();
    await this.saveChatHistory();
  }

  private chatAboutActiveNote(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note.");
      return;
    }
    this.openChatWithMessage(`Tell me about ${file.path}`);
  }

  /** Open or reveal the chat view in the right sidebar (both desktop and mobile). */
  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT);

    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }

    // Right sidebar on both desktop and mobile.
    // On mobile, this slides in as a panel from the right edge.
    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  /** Get the active ObsidianChatView using proper instanceof check (deferred view safe) */
  private getChatView(): ObsidianChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    for (const leaf of leaves) {
      if (leaf.view instanceof ObsidianChatView) {
        return leaf.view;
      }
    }
    return null;
  }

  private shareTranscript(): void {
    const view = this.getChatView();
    if (!view) {
      new Notice("No active conversation.");
      return;
    }

    const transcript = view.getTranscript();
    if (!transcript || transcript.endsWith("## Conversation\n\n")) {
      new Notice("Conversation is empty.");
      return;
    }

    navigator.clipboard.writeText(transcript).then(() => {
      new Notice("Transcript copied to clipboard.");
    }).catch(() => {
      new Notice("Failed to copy transcript.");
    });
  }

  /**
   * Empty the current conversation in place. This keeps the session (and its
   * position in the switcher) rather than deleting it, which is what the
   * command has always meant.
   */
  private clearChat(): void {
    const view = this.getChatView();
    if (view) {
      view.clearConversation();
      new Notice("Conversation cleared.");
    } else {
      new Notice("No active conversation.");
    }
  }

  // ─── Chat history persistence ─────────────────────────────────────────

  async saveChatHistory(): Promise<void> {
    try {
      const state = this.sessions.toPersisted();
      await this.app.vault.adapter.write(
        ".obsidian/plugins/obsidian-chat/chat-state.json",
        JSON.stringify(state)
      );
    } catch {
      // Persistence is best-effort
    }
  }

  private async loadChatHistory(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(
        ".obsidian/plugins/obsidian-chat/chat-state.json"
      );
      // Handles both the multi-session shape and the older single
      // conversation, which is migrated into one session.
      this.sessions.restore(JSON.parse(raw));
    } catch {
      // No saved state or parse error — start fresh
    }
  }

  // ─── Settings persistence ────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

    // Fall back to default model if saved model is empty
    if (!this.settings.model) {
      this.settings.model = DEFAULT_SETTINGS.model;
    }

    // Load API key for the current provider from SecretStorage
    this.settings.apiKey = this.loadApiKey(this.settings.provider);
  }

  async saveSettings(): Promise<void> {
    // Store API key in SecretStorage keyed by provider
    this.saveApiKey(this.settings.provider, this.settings.apiKey || "");

    // Save all other settings to data.json (syncs), but strip the API key
    const toSave = { ...this.settings, apiKey: "" };
    await this.saveData(toSave);

    // Update the chat view header with the new model name
    this.getChatView()?.updateModel(
      getModelDisplayName(this.settings.provider, this.settings.model)
    );
  }

  /** Load the correct API key when provider changes */
  reloadApiKeyForProvider(): void {
    this.settings.apiKey = this.loadApiKey(this.settings.provider);
  }

  private loadApiKey(provider: string): string {
    try {
      return this.app.secretStorage.getSecret(`obsidian-chat-api-key-${provider}`) || "";
    } catch {
      return "";
    }
  }

  private saveApiKey(provider: string, key: string): void {
    try {
      this.app.secretStorage.setSecret(`obsidian-chat-api-key-${provider}`, key);
    } catch {
      // SecretStorage not available
    }
  }
}
