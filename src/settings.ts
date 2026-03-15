import { App, Notice, PluginSettingTab, Setting, requestUrl } from "obsidian";
import type ChatPlugin from "./main";
import type { Provider } from "./types";

interface ModelOption {
  value: string;
  label: string;
}

const FALLBACK_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { value: "gpt-5.3-codex", label: "Codex 5.3" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-4o", label: "GPT-4o" },
  ],
};

// Cache fetched models per provider so they survive tab re-opens
const modelCache = new Map<string, ModelOption[]>();

// ─── Settings Tab ───────────────────────────────────────────────────────────

export class ChatSettingTab extends PluginSettingTab {
  plugin: ChatPlugin;

  constructor(app: App, plugin: ChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian Chat" });

    const s = this.plugin.settings;

    // ─── Provider ─────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Which AI provider to use")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("anthropic", "Anthropic")
          .addOption("openai", "OpenAI")
          .setValue(s.provider)
          .onChange(async (value) => {
            // Load the new provider's key BEFORE saving,
            // otherwise the old provider's key gets saved under the new provider name
            s.provider = value as Provider;
            s.model = "";
            this.plugin.reloadApiKeyForProvider();
            await this.plugin.saveSettings();
            setTimeout(() => this.display(), 10);
          })
      );

    // ─── API Key ──────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("API key")
      .setDesc(s.apiKey ? "Key saved" : "Enter your API key to get started")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter your API key")
          .setValue(s.apiKey)
          .onChange(async (value) => {
            const hadKey = !!s.apiKey;
            s.apiKey = value.trim();
            await this.plugin.saveSettings();
            // Re-render when key goes from empty to set (shows refresh button)
            if (!hadKey && s.apiKey) {
              setTimeout(() => this.display(), 10);
            }
          });
      });

    // ─── Model ────────────────────────────────────────────────────────
    const cached = modelCache.get(s.provider);
    const models = cached || FALLBACK_MODELS[s.provider] || FALLBACK_MODELS.anthropic;

    const modelSetting = new Setting(containerEl)
      .setName("Model")
      .setDesc(cached ? `${cached.length} models from API` : "Using defaults. Click refresh to load from API.")
      .addDropdown((dropdown) => {
        for (const m of models) {
          dropdown.addOption(m.value, m.label);
        }
        dropdown.addOption("__custom__", "Custom...");

        // If current model isn't in the list, add it
        if (s.model && !models.some((m) => m.value === s.model)) {
          dropdown.addOption(s.model, `${s.model} (current)`);
        }

        dropdown.setValue(s.model || models[0]?.value || "");
        dropdown.onChange(async (value) => {
          if (value === "__custom__") {
            s.model = "";
            await this.plugin.saveSettings();
            setTimeout(() => this.display(), 10);
          } else {
            s.model = value;
            await this.plugin.saveSettings();
          }
        });
      });

    // Refresh button
    if (s.apiKey) {
      modelSetting.addButton((btn) =>
        btn
          .setIcon("refresh-cw")
          .setTooltip("Fetch models from API")
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              const fetched = await fetchModelsFromAPI(s.provider, s.apiKey);
              modelCache.set(s.provider, fetched);
              new Notice(`Loaded ${fetched.length} models`);
              if (!s.model && fetched.length > 0) {
                s.model = fetched[0].value;
                await this.plugin.saveSettings();
              }
              this.display();
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(`Failed to fetch models: ${msg}`);
            }
          })
      );
    }

    // Custom model text field (shown when Custom... selected or model is empty)
    if (!s.model) {
      new Setting(containerEl)
        .setName("Custom model ID")
        .setDesc("Enter the full model identifier")
        .addText((text) =>
          text
            .setPlaceholder(s.provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o")
            .setValue(s.model)
            .onChange(async (value) => {
              s.model = value.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    // ─── Web search ───────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Web search")
      .setDesc("Allow the model to search the web when it needs current information")
      .addToggle((toggle) =>
        toggle
          .setValue(s.enableWebSearch)
          .onChange(async (value) => {
            s.enableWebSearch = value;
            await this.plugin.saveSettings();
          })
      );

    // ─── Max iterations ───────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Max tool iterations")
      .setDesc("Safety limit for the agent loop (default: 20)")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(s.maxIterations))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0 && n <= 100) {
              s.maxIterations = n;
              await this.plugin.saveSettings();
            }
          })
      );

    // ─── System prompt override ───────────────────────────────────────
    new Setting(containerEl)
      .setName("System prompt override")
      .setDesc("Custom system prompt (leave empty to use default)")
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text.inputEl.style.width = "100%";
        text
          .setPlaceholder("Leave empty for default system prompt")
          .setValue(s.systemPromptOverride)
          .onChange(async (value) => {
            s.systemPromptOverride = value;
            await this.plugin.saveSettings();
          });
      });

    // ─── Test connection ──────────────────────────────────────────────
    const testSetting = new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify that the API key and model work");

    testSetting.addButton((button) =>
      button.setButtonText("Test").onClick(async () => {
        if (!s.apiKey) {
          new Notice("API key is required");
          return;
        }

        button.setButtonText("Testing...");
        button.setDisabled(true);

        try {
          const { sendMessage } = await import("./api/client");
          const response = await sendMessage(
            s,
            [{ role: "user", content: "Say hello in one word." }],
            [],
            "You are a test. Respond with one word."
          );

          const text = response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");

          new Notice(`Connected! Response: "${text}"`);
          testSetting.setDesc("Connection successful");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          new Notice(`Connection failed: ${msg}`);
          testSetting.setDesc(`Failed: ${msg}`);
        } finally {
          button.setButtonText("Test");
          button.setDisabled(false);
        }
      })
    );
  }
}

// ─── Model Fetching (only triggered by explicit refresh button click) ───────

async function fetchModelsFromAPI(
  provider: Provider,
  apiKey: string
): Promise<ModelOption[]> {
  if (provider === "anthropic") {
    return fetchAnthropicModels(apiKey);
  }
  return fetchOpenAIModels(apiKey);
}

async function fetchAnthropicModels(apiKey: string): Promise<ModelOption[]> {
  let response;
  try {
    response = await requestUrl({
      url: "https://api.anthropic.com/v1/models?limit=100",
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }

  const models = (response.json?.data || [])
    .filter((m: { type?: string }) => m.type === "model")
    .map((m: { id: string; display_name?: string }) => ({
      value: m.id,
      label: m.display_name || m.id,
    }))
    .sort((a: ModelOption, b: ModelOption) => {
      const da = a.value.match(/(\d{8})/)?.[1] || "";
      const db = b.value.match(/(\d{8})/)?.[1] || "";
      return db.localeCompare(da) || a.label.localeCompare(b.label);
    });

  return models.length > 0 ? models : FALLBACK_MODELS.anthropic;
}

async function fetchOpenAIModels(apiKey: string): Promise<ModelOption[]> {
  let response;
  try {
    response = await requestUrl({
      url: "https://api.openai.com/v1/models",
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }

  const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-", "codex-", "gpt5"];
  const excludePatterns = ["realtime", "audio", "transcri", "search"];

  const models = (response.json?.data || [])
    .filter((m: { id: string }) => {
      const id = m.id.toLowerCase();
      return chatPrefixes.some((p) => id.startsWith(p)) &&
        !excludePatterns.some((p) => id.includes(p));
    })
    .sort((a: { created?: number }, b: { created?: number }) =>
      (b.created || 0) - (a.created || 0)
    )
    .map((m: { id: string }) => ({ value: m.id, label: m.id }));

  return models.length > 0 ? models : FALLBACK_MODELS.openai;
}
