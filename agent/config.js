// HackyTab Agent: model provider configuration.
//
// This is the ONE file to edit to change which model powers the product.
// Nothing outside agent/ knows which provider is behind planTabs().
//
// API keys never live here. They are entered in the side panel Settings and
// stored in chrome.storage.local (spec N4). Setting `provider` below changes
// which key field the Settings panel labels and which endpoint is called.
//
// To add a provider, add an entry to PROVIDERS in agent/providers.js and
// point `provider` at it.

export const MODEL_CONFIG = {
  // Which entry in PROVIDERS (agent/providers.js) to use.
  // Built in: "anthropic" | "nvidia"
  provider: "anthropic",

  // Per-provider overrides. Leave a field out to use the provider default.
  overrides: {
    anthropic: {
      model: "claude-fable-5-1",
      effort: "low"            // "low" | "medium" | "high"
    },
    nvidia: {
      // NVIDIA NIM (build.nvidia.com), OpenAI-compatible chat completions.
      // Pick any hosted open model id, for example:
      //   "moonshotai/kimi-k2-instruct"
      //   "z-ai/glm-4.7"
      // Confirm the exact id on the model's page at build.nvidia.com.
      model: "moonshotai/kimi-k2-instruct",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      temperature: 0.2,
      maxTokens: 4096
    }
  },

  // Hard limit for the whole planning call, in ms (spec N2). Fallback plan after this.
  timeoutMs: 15000
};
