<script lang="ts">
  import type { App, Component as ObsidianComponent } from "obsidian";
  import { MarkdownRenderer } from "obsidian";
  import type { ToolResult, SelectionScope } from "../types";

  interface ChatMessage {
    id: number;
    type: "user" | "assistant" | "tool-call" | "tool-result" | "error" | "thinking";
    text?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: ToolResult;
  }

  interface Props {
    app: App;
    component: ObsidianComponent;
    provider: string;
    model: string;
    onSend: (text: string, selection: SelectionScope | null) => void;
    onClear: () => void;
  }

  let { app, component, provider, model, onSend, onClear }: Props = $props();

  let messages = $state<ChatMessage[]>([]);
  let inputText = $state("");
  let inputEnabled = $state(true);
  let placeholder = $state("Ask anything...");
  let messagesEl: HTMLElement | undefined = $state();
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let nextId = 0;

  // Selection scope (shown as a pill above input)
  let selection = $state<SelectionScope | null>(null);

  // ask_user support
  let askUserResolve: ((value: string) => void) | null = $state(null);

  // Auto-scroll when messages change
  $effect(() => {
    // Track messages array length to trigger scroll
    messages.length;
    if (messagesEl) {
      requestAnimationFrame(() => {
        messagesEl!.scrollTop = messagesEl!.scrollHeight;
      });
    }
  });

  // ─── Public API (called from chat-view.ts / chat-modal.ts) ────────────

  export function addUserMessage(text: string): void {
    messages.push({ id: nextId++, type: "user", text });
  }

  export function addAssistantMessage(text: string): void {
    messages.push({ id: nextId++, type: "assistant", text });
  }

  export function addToolCall(name: string, input: Record<string, unknown>): number {
    const id = nextId++;
    messages.push({ id, type: "tool-call", toolName: name, toolInput: input });
    return id;
  }

  export function updateToolResult(msgId: number, name: string, result: ToolResult): void {
    const msg = messages.find((m) => m.id === msgId);
    if (msg) {
      msg.type = "tool-result";
      msg.toolName = name;
      msg.toolResult = result;
    }
  }

  export function showThinking(): void {
    // Only add if not already showing
    if (!messages.some((m) => m.type === "thinking")) {
      messages.push({ id: nextId++, type: "thinking" });
    }
  }

  export function hideThinking(): void {
    const idx = messages.findIndex((m) => m.type === "thinking");
    if (idx !== -1) messages.splice(idx, 1);
  }

  export function addError(text: string): void {
    messages.push({ id: nextId++, type: "error", text });
  }

  export function showAskUser(question: string): Promise<string> {
    addAssistantMessage(question);
    placeholder = "Type your answer...";
    inputEnabled = true;
    textareaEl?.focus();

    return new Promise<string>((resolve) => {
      askUserResolve = resolve;
    });
  }

  export function setInputEnabled(enabled: boolean): void {
    inputEnabled = enabled;
    placeholder = enabled ? "Ask anything..." : "Waiting for response...";
  }

  export function clearMessages(): void {
    messages = [];
    selection = null;
    hideThinking();
  }

  export function focus(): void {
    textareaEl?.focus();
  }

  /** Set the selection scope (shows pill in UI) */
  export function setSelection(sel: SelectionScope): void {
    selection = sel;
  }

  /** Get the current selection scope */
  export function getSelection(): SelectionScope | null {
    return selection;
  }

  /** Clear the selection scope */
  export function clearSelection(): void {
    selection = null;
  }

  // ─── Internal handlers ────────────────────────────────────────────────

  function handleSend(): void {
    const text = inputText.trim();
    if (!text) return;

    inputText = "";
    resetHeight();

    if (askUserResolve) {
      addUserMessage(text);
      const resolve = askUserResolve;
      askUserResolve = null;
      resolve(text);
      return;
    }

    // Pass current selection and consume it (one-shot per send)
    const currentSelection = selection;
    selection = null;
    onSend(text, currentSelection);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function autoGrow(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 150) + "px";
  }

  function resetHeight(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
  }

  // Render markdown into a DOM node using Obsidian's renderer
  function renderMarkdown(node: HTMLElement, text: string): void {
    node.empty();
    MarkdownRenderer.render(app, text, node, "", component);
  }

  // Use action for markdown rendering
  function markdown(node: HTMLElement, text: string) {
    renderMarkdown(node, text);
    return {
      update(newText: string) {
        renderMarkdown(node, newText);
      },
    };
  }

  function formatToolName(name: string): string {
    return name.replace(/_/g, " ");
  }

  function truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    return str.substring(0, max) + "\n... (truncated)";
  }
</script>

<div class="ochat-container">
  <!-- Header -->
  <div class="ochat-header">
    <div class="ochat-header-left">
      <span class="ochat-header-title">Chat</span>
      <span class="ochat-header-model">{model || "No model"}</span>
    </div>
    <button class="ochat-clear-btn" onclick={onClear}>Clear</button>
  </div>

  <!-- Messages -->
  <div class="ochat-messages" bind:this={messagesEl}>
    {#each messages as msg (msg.id)}
      {#if msg.type === "user"}
        <div class="ochat-msg ochat-user-msg">
          <div class="ochat-msg-content">{msg.text}</div>
        </div>

      {:else if msg.type === "assistant"}
        <div class="ochat-msg ochat-assistant-msg">
          <div class="ochat-msg-content" use:markdown={msg.text ?? ""}></div>
        </div>

      {:else if msg.type === "tool-call"}
        <div class="ochat-tool-call">
          <div class="ochat-tool-status">
            <span class="ochat-spinner"></span>
            <span class="ochat-tool-name">{formatToolName(msg.toolName ?? "")}</span>
          </div>
          <details class="ochat-tool-details">
            <summary>Parameters</summary>
            <pre class="ochat-tool-json">{JSON.stringify(msg.toolInput, null, 2)}</pre>
          </details>
        </div>

      {:else if msg.type === "tool-result"}
        <div class="ochat-tool-call">
          <div class="ochat-tool-status">
            <span class={msg.toolResult?.isError ? "ochat-tool-error" : "ochat-tool-success"}>
              {msg.toolResult?.isError ? "\u2718" : "\u2714"}
            </span>
            <span class="ochat-tool-name">{formatToolName(msg.toolName ?? "")}</span>
          </div>
          <details class="ochat-tool-details">
            <summary>{msg.toolResult?.isError ? "Error" : "Result"}</summary>
            <pre class="ochat-tool-json">{truncate(msg.toolResult?.result ?? "", 2000)}</pre>
          </details>
        </div>

      {:else if msg.type === "error"}
        <div class="ochat-msg ochat-error-msg">
          <div class="ochat-msg-content">{msg.text}</div>
        </div>

      {:else if msg.type === "thinking"}
        <div class="ochat-thinking">
          <span class="ochat-dot"></span>
          <span class="ochat-dot"></span>
          <span class="ochat-dot"></span>
        </div>
      {/if}
    {/each}
  </div>

  <!-- Selection pill -->
  {#if selection}
    <div class="ochat-selection-pill">
      <div class="ochat-selection-content">
        <span class="ochat-selection-label">Selection from {selection.filePath.split("/").pop()}</span>
        <span class="ochat-selection-preview">{selection.text.substring(0, 80)}{selection.text.length > 80 ? "..." : ""}</span>
      </div>
      <button
        class="ochat-selection-dismiss"
        onclick={() => selection = null}
        aria-label="Remove selection"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  {/if}

  <!-- Input bar -->
  <div class="ochat-input-bar">
    <textarea
      class="ochat-input"
      bind:this={textareaEl}
      bind:value={inputText}
      {placeholder}
      disabled={!inputEnabled}
      rows="1"
      onkeydown={handleKeydown}
      oninput={autoGrow}
    ></textarea>
    <button
      class="ochat-send-btn"
      disabled={!inputEnabled}
      onclick={handleSend}
      aria-label="Send message"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
    </button>
  </div>
</div>

<style>
  /* ─── Container ─────────────────────────────────────────────────────── */
  .ochat-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ─── Header ────────────────────────────────────────────────────────── */
  .ochat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  .ochat-header-left {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .ochat-header-title {
    font-weight: var(--font-weight-bold, 600);
    font-size: var(--font-ui-medium);
    color: var(--text-normal);
  }

  .ochat-header-model {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .ochat-clear-btn {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--radius-s);
  }

  .ochat-clear-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  /* ─── Messages ──────────────────────────────────────────────────────── */
  .ochat-messages {
    flex: 1 1 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .ochat-msg {
    max-width: 90%;
    padding: 8px 12px;
    border-radius: var(--radius-m);
    line-height: 1.5;
    word-wrap: break-word;
  }

  .ochat-user-msg {
    align-self: flex-end;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-bottom-right-radius: var(--radius-s);
  }

  .ochat-assistant-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-normal);
    border-bottom-left-radius: var(--radius-s);
  }

  .ochat-assistant-msg :global(p:first-child) {
    margin-top: 0;
  }

  .ochat-assistant-msg :global(p:last-child) {
    margin-bottom: 0;
  }

  .ochat-error-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-error);
    border-left: 3px solid var(--text-error);
    font-size: var(--font-ui-smaller);
    max-width: 90%;
  }

  /* ─── Tool Calls ────────────────────────────────────────────────────── */
  .ochat-tool-call {
    align-self: flex-start;
    padding: 6px 10px;
    background: var(--background-secondary-alt);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    max-width: 90%;
  }

  .ochat-tool-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ochat-tool-name {
    font-weight: 500;
  }

  .ochat-tool-success {
    color: var(--text-success);
  }

  .ochat-tool-error {
    color: var(--text-error);
  }

  .ochat-tool-details {
    margin-top: 4px;
  }

  .ochat-tool-details summary {
    cursor: pointer;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }

  .ochat-tool-json {
    margin: 4px 0 0;
    padding: 6px 8px;
    background: var(--background-primary);
    border-radius: var(--radius-s);
    font-size: 11px;
    max-height: 150px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ─── Spinner ───────────────────────────────────────────────────────── */
  .ochat-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--text-faint);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: ochat-spin 0.6s linear infinite;
  }

  @keyframes ochat-spin {
    to { transform: rotate(360deg); }
  }

  /* ─── Thinking Dots ─────────────────────────────────────────────────── */
  .ochat-thinking {
    align-self: flex-start;
    display: flex;
    gap: 4px;
    padding: 8px 12px;
  }

  .ochat-dot {
    width: 8px;
    height: 8px;
    background: var(--text-faint);
    border-radius: 50%;
    animation: ochat-pulse 1.4s ease-in-out infinite;
  }

  .ochat-dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .ochat-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes ochat-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  /* ─── Input Bar ─────────────────────────────────────────────────────── */
  .ochat-input-bar {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 12px;
    padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--background-modifier-border);
    background: var(--background-primary);
    flex-shrink: 0;
  }

  .ochat-input {
    flex: 1;
    resize: none;
    border: 1.5px solid var(--background-modifier-border-hover, var(--background-modifier-border));
    border-radius: 20px;
    padding: 8px 16px;
    font-size: var(--font-ui-medium);
    font-family: var(--font-interface);
    background-color: var(--background-secondary);
    color: var(--text-normal);
    line-height: 1.4;
    max-height: 150px;
    overflow-y: auto;
    box-shadow: none;
  }

  .ochat-input:focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: none;
  }

  .ochat-input:disabled {
    opacity: 0.5;
  }

  .ochat-send-btn {
    width: 34px;
    height: 34px;
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background-color: var(--interactive-accent);
    color: var(--text-on-accent);
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: none;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 1px;
  }

  .ochat-send-btn:hover {
    background-color: var(--interactive-accent-hover);
  }

  .ochat-send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ─── Selection Pill ─────────────────────────────────────────────────── */
  .ochat-selection-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 8px 0;
    padding: 6px 10px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    flex-shrink: 0;
  }

  .ochat-selection-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .ochat-selection-label {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    font-weight: 500;
  }

  .ochat-selection-preview {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ochat-selection-dismiss {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--background-modifier-hover);
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ochat-selection-dismiss:hover {
    background: var(--background-modifier-border);
    color: var(--text-normal);
  }

  /* ─── Responsive ────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    .ochat-msg {
      max-width: 95%;
    }

    .ochat-input-bar {
      gap: 10px;
      padding: 10px 12px;
      padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    }

    .ochat-input {
      font-size: 16px; /* Prevents iOS zoom on focus */
      padding: 10px 16px;
      border-radius: 22px;
    }

    .ochat-send-btn {
      width: 36px;
      height: 36px;
      min-width: 36px;
      min-height: 36px;
    }
  }
</style>
