// HackyTab Agent: model provider configuration.
//
// This is the ONE file to edit to change which model powers the product.
// Nothing outside agent/ knows which provider is behind planTabs().
//
// API keys never live here. They are entered in the side panel Settings and
// stored in chrome.storage.local (spec N4). The Settings panel can also switch
// provider and model at runtime; values here are the defaults.
//
// Model ids per provider are listed in agent/providers.js (PROVIDERS[name].models)
// and drive the model dropdown in Settings. Add a provider there and point
// `provider` at it.

export const MODEL_CONFIG = {
  // Which entry in PROVIDERS (agent/providers.js) to use by default.
  // Built in: "anthropic" | "openai" | "nvidia"
  provider: "anthropic",

  // Per-provider overrides. Leave a field out to use the provider default.
  overrides: {
    anthropic: {
      model: "claude-fable-5-1",
      effort: "low"            // "low" | "medium" | "high"
    },
    openai: {
      model: "gpt-5.6-terra",  // see PROVIDERS.openai.models for the verified list
      reasoningEffort: "low"
    },
    nvidia: {
      // Open models on NVIDIA NIM. Ids verified against
      // https://integrate.api.nvidia.com/v1/models on Sep 12 2026. See the
      // latency notes above PROVIDERS.nvidia in providers.js before changing.
      model: "deepseek-ai/deepseek-v4-flash-0731",
      temperature: 0.2
    }
  },

  // Hard limit for the whole planning call, in ms (spec N2). Fallback plan after this.
  timeoutMs: 15000
};
