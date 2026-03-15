import type { UnifiedToolDef } from "../types";

/**
 * All 9 tools the agent can call. Deliberately minimal:
 * read, edit, search, create, list, read-any, rename, delete, and ask-user.
 */
export const TOOL_DEFINITIONS: UnifiedToolDef[] = [
  {
    name: "read_document",
    description:
      "Read the content of a markdown document. If no path is given, reads the currently active document.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document relative to vault root. Omit to read the active document.",
        },
      },
      required: [],
    },
  },
  {
    name: "edit_document",
    description:
      "Edit a markdown document. Supports three operations: 'replace_all' replaces the entire content, 'find_replace' finds a specific string and replaces it, 'insert' adds content at a position.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document. Omit to edit the active document.",
        },
        operation: {
          type: "string",
          enum: ["replace_all", "find_replace", "insert"],
          description: "The type of edit to perform.",
        },
        content: {
          type: "string",
          description: "The new content (for replace_all), replacement text (for find_replace), or text to insert.",
        },
        find: {
          type: "string",
          description: "The exact text to find (required for find_replace).",
        },
        position: {
          type: "string",
          enum: ["beginning", "end", "after_frontmatter"],
          description: "Where to insert content (required for insert). 'after_frontmatter' inserts after the --- block.",
        },
      },
      required: ["operation", "content"],
    },
  },
  {
    name: "search_vault",
    description:
      "Search for files in the vault by filename or content. Returns matching file paths and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (matched against filenames and optionally content).",
        },
        searchContent: {
          type: "boolean",
          description: "Whether to also search inside file contents (slower). Default: false.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return. Default: 10.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Read the full content of any file in the vault by its path.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file relative to vault root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "create_file",
    description: "Create a new file in the vault. Fails if the file already exists.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path for the new file relative to vault root (e.g. 'Notes/meeting.md').",
        },
        content: {
          type: "string",
          description: "Content of the new file.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List files in the vault, optionally filtered by folder and/or extension.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Folder path to list (e.g. 'Projects'). Omit to list all files.",
        },
        extension: {
          type: "string",
          description: "Filter by file extension (e.g. 'md'). Omit to include all types.",
        },
      },
      required: [],
    },
  },
  {
    name: "rename_file",
    description: "Rename or move a file in the vault. Can be used to rename a note or move it to a different folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Current path of the file relative to vault root.",
        },
        new_path: {
          type: "string",
          description: "New path for the file relative to vault root.",
        },
      },
      required: ["path", "new_path"],
    },
  },
  {
    name: "delete_file",
    description: "Move a file to the Obsidian trash. Use with caution.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path of the file to delete relative to vault root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user a clarifying question. Use this when you need more information before proceeding. The conversation will pause until the user responds.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user.",
        },
      },
      required: ["question"],
    },
  },
];
