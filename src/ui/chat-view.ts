import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { mount, unmount } from "svelte";
import type ChatPlugin from "../main";
import ChatContainer from "./ChatContainer.svelte";
import type { ToolResult, SelectionScope } from "../types";

export const VIEW_TYPE_CHAT = "ochat-view";

/**
 * Chat view for Obsidian Chat.
 * Desktop: right sidebar. Mobile: right sidebar (slides in from edge).
 * Uses the plugin's shared AgentLoop and chatHistory so conversations
 * survive the view being closed and reopened (e.g. sidebar toggle).
 */
export class ObsidianChatView extends ItemView {
  private plugin: ChatPlugin;
  private chatContainer: ReturnType<typeof ChatContainer> | undefined;
  private running = false;

  constructor(leaf: WorkspaceLeaf, plugin: ChatPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return "Chat";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("ochat-view-container");

    this.chatContainer = mount(ChatContainer, {
      target: container,
      props: {
        app: this.app,
        component: this,
        onSend: (text: string, selection: SelectionScope | null) =>
          this.handleUserMessage(text, selection),
        onClear: () => this.handleClear(),
      },
    });

    // Replay chat history into the UI
    for (const msg of this.plugin.chatHistory) {
      switch (msg.type) {
        case "user":
          this.chatContainer.addUserMessage(msg.text!);
          break;
        case "assistant":
          this.chatContainer.addAssistantMessage(msg.text!);
          break;
        case "tool-result":
          if (msg.toolName && msg.toolResult) {
            const id = this.chatContainer.addToolCall(msg.toolName, msg.toolInput || {});
            this.chatContainer.updateToolResult(id, msg.toolName, msg.toolResult);
          }
          break;
        case "error":
          this.chatContainer.addError(msg.text!);
          break;
      }
    }

    this.chatContainer.focus();
  }

  async onClose(): Promise<void> {
    this.plugin.agent.abort();
    if (this.chatContainer) {
      unmount(this.chatContainer);
      this.chatContainer = undefined;
    }
  }

  /** Export the full transcript for debugging */
  getTranscript(): string {
    return this.plugin.agent.exportTranscript();
  }

  /** Programmatically send a message */
  sendMessage(text: string): void {
    this.handleUserMessage(text, this.chatContainer?.getSelection() ?? null);
  }

  /** Set the selection scope and show the pill */
  setSelection(selection: SelectionScope): void {
    this.chatContainer?.setSelection(selection);
  }

  /** Focus the input */
  focus(): void {
    this.chatContainer?.focus();
  }

  /** Clear conversation */
  clearConversation(): void {
    this.handleClear();
  }

  private async handleUserMessage(
    text: string,
    selection: SelectionScope | null
  ): Promise<void> {
    if (this.running) {
      new Notice("Please wait for the current response to complete.");
      return;
    }

    const chat = this.chatContainer!;
    const history = this.plugin.chatHistory;

    this.running = true;
    chat.addUserMessage(text);
    history.push({ type: "user", text });
    chat.setInputEnabled(false);

    const toolCallIds = new Map<string, number>();

    try {
      await this.plugin.agent.run(text, {
        onThinking: () => {
          chat.showThinking();
        },
        onToolCall: (name, input) => {
          chat.hideThinking();
          if (name === "ask_user") return;
          const msgId = chat.addToolCall(name, input);
          toolCallIds.set(`latest-${name}`, msgId);
        },
        onToolResult: (name, result: ToolResult) => {
          if (name === "ask_user") return;
          const msgId = toolCallIds.get(`latest-${name}`);
          if (msgId !== undefined) {
            chat.updateToolResult(msgId, name, result);
          }
          history.push({ type: "tool-result", toolName: name, toolInput: {}, toolResult: result });
        },
        onResponse: (text) => {
          chat.hideThinking();
          chat.addAssistantMessage(text);
          history.push({ type: "assistant", text });
        },
        onAskUser: async (question) => {
          chat.hideThinking();
          chat.setInputEnabled(true);
          const answer = await chat.showAskUser(question);
          chat.setInputEnabled(false);
          return answer;
        },
        onError: (error) => {
          chat.hideThinking();
          chat.addError(error);
          history.push({ type: "error", text: error });
        },
      }, selection);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      chat.addError(`Unexpected error: ${msg}`);
      history.push({ type: "error", text: `Unexpected error: ${msg}` });
    } finally {
      this.running = false;
      chat.setInputEnabled(true);
      chat.focus();
    }
  }

  private handleClear(): void {
    this.plugin.agent.abort();
    this.plugin.agent.clear();
    this.plugin.chatHistory = [];
    this.chatContainer?.clearMessages();
    this.running = false;
    this.chatContainer?.setInputEnabled(true);
  }
}
