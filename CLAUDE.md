# Obsidian Chat

Agentic AI chat plugin for Obsidian. Simple, mobile-first, two providers (Anthropic + OpenAI).

## Architecture

```
User Input -> Agent Loop -> API Client (requestUrl) -> Claude/OpenAI
                 |                                         |
            Tool Executor  <---  tool_use response  <------+
                 |
         Obsidian Vault APIs (read/edit/search/create)
```

- **API clients** use `requestUrl()` (not `fetch`) because mobile WebViews enforce CORS
- **Anthropic** uses Messages API with adaptive thinking and prompt caching
- **OpenAI** uses Responses API with `previous_response_id` for multi-turn
- **Agent loop** is provider-agnostic: send -> tools -> send -> done
- **UI** is a single Svelte 5 component (`ChatContainer.svelte`) mounted in an `ItemView`

## Project Structure

```
src/
  main.ts                # Plugin entry: commands, views, settings, context menus
  types.ts               # All interfaces and defaults
  settings.ts            # PluginSettingTab with model fetching
  api/
    client.ts            # Dispatcher: routes to anthropic or openai adapter
    anthropic.ts         # Messages API, adaptive thinking, cache_control
    openai.ts            # Responses API, previous_response_id chaining
  tools/
    registry.ts          # 9 tool definitions (JSON Schema)
    executor.ts          # Runs tools against Obsidian Vault APIs
  agent/
    loop.ts              # Core agentic loop with selection scope
    context.ts           # Builds vault context (active file, selection)
    system-prompt.ts     # Static system prompt (KV cache optimized)
  ui/
    chat-view.ts         # ItemView wrapper, mounts Svelte component
    ChatContainer.svelte # All chat UI: messages, input, selection pill
```

## Key Patterns

- **KV cache optimization**: System prompt is static (never includes dynamic context). Dynamic context (active file, selection) goes in the user message after the cached prefix.
- **Anthropic `cache_control`**: Breakpoints on system prompt and last tool definition.
- **Per-provider API keys**: Stored as `ochat-api-key-anthropic` / `ochat-api-key-openai` in `SecretStorage`.
- **In-memory chat persistence**: `AgentLoop` and `chatHistory` live on the plugin instance, surviving view open/close cycles.
- **Selection scope**: Injected into user message with scoping instructions. Model uses `find_replace` within selection text.

## Build

```bash
npm install
npm run build          # Production
npm run dev            # Watch mode
npx tsc --noEmit       # Type check
npm run svelte-check   # Svelte check
```

## Tools

| Tool | Obsidian API | Notes |
|------|-------------|-------|
| read_document | `vault.cachedRead()` | Falls back to active file if no path |
| edit_document | `vault.process()` | Atomic read-modify-write |
| search_vault | `getMarkdownFiles()` + `cachedRead()` | Linear scan, capped |
| read_file | `vault.getFileByPath()` + `cachedRead()` | Any file type |
| create_file | `vault.create()` | Auto-creates parent folders |
| list_files | `vault.getFiles()` | Capped at 100 results |
| rename_file | `fileManager.renameFile()` | Updates all links |
| delete_file | `vault.trash()` | Respects user trash setting |
| ask_user | UI callback | Pauses agent loop |

## Debug

Set `DEBUG = true` in `src/agent/loop.ts` to write API calls and errors to `.obsidian/plugins/obsidian-chat/debug.log`.
