import { App } from "obsidian";
import type { ConversationContext } from "../types";

/**
 * Builds a snapshot of the current workspace context.
 * Refreshed each turn so the system prompt reflects the latest state.
 */
export function buildContext(app: App): ConversationContext {
  const activeFile = app.workspace.getActiveFile();
  let activeFileContent: string | null = null;
  let selection: string | null = null;

  // Get selection from active editor
  const editor = app.workspace.activeEditor?.editor;
  if (editor) {
    const sel = editor.getSelection();
    if (sel && sel.length > 0) {
      selection = sel;
    }
  }

  return {
    activeFile: activeFile?.path ?? null,
    activeFileContent, // Populated lazily by the loop if needed
    selection,
    vaultName: app.vault.getName(),
    fileCount: app.vault.getMarkdownFiles().length,
  };
}
