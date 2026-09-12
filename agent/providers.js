// HackyTab Agent: provider adapters.
//
// Each adapter turns (systemPrompt, userPayload, schema, settings) into one
// HTTP request and returns the raw JSON text the model produced, or throws.
// planTabs() in agent/plan.js handles parsing, validation, retry, and fallback.
//
// Every adapter must:
//   - read the API key from settings.apiKey (chrome.storage.local), never from config
//   - never log the key or the request headers
//   - return a string containing only the model's JSON output
//   - list its selectable models in `models` (drives the Settings dropdown)
//
// Adding a provider: add an entry to PROVIDERS with
// { label, keyLabel, hosts, defaults, models, call }. `hosts` is documentation
// only; manifest.json host_permissions must list them statically, so add the
// host there too.

import { MODEL_CONFIG } from "./config.js";

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// --------------------------------------------------------------------------
// Anthropic Messages API (spec section 7)
// --------------------------------------------------------------------------
const anthropic = {
  label: "Anthropic (Claude)",
  keyLabel: "Anthropic API key",
  hosts: ["https://api.anthropic.com/*"],
  defaults: { model: "claude-fable-5-1", effort: "low", maxTokens: 4096 },
  models: [{ id: "claude-fable-5-1", label: "Claude Fable 5.1" }],

  async call({ system, user, schema, settings, opts, timeoutMs }) {
    const body = {
      model: opts.model,
      max_tokens: opts.maxTokens,
      output_config: {
        effort: opts.effort,
        format: { type: "json_schema", schema }
      },
      fallbacks: "default",
      system,
      messages: [{ role: "user", content: JSON.stringify(user) }]
    };
    const res = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": settings.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "server-side-fallback-2026-07-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify(body)
      },
      timeoutMs
    );
    if (!res.ok) throw new Error(`anthropic http ${res.status}`);
    const data = await res.json();
    if (data.stop_reason === "refusal") throw new Error("anthropic refusal");
    const text = data.content?.[0]?.text;
    if (typeof text !== "string") throw new Error("anthropic empty content");
    return text;
  }
};

// --------------------------------------------------------------------------
// OpenAI-compatible chat completions. Used for OpenAI itself and for NVIDIA
// NIM (GLM, Kimi, DeepSeek, ...). Reusable for any endpoint that speaks
// POST {baseUrl}/chat/completions with a Bearer token.
// --------------------------------------------------------------------------
function extractJson(text) {
  // Some open models wrap JSON in a markdown fence or emit reasoning first.
  text = String(text).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start > 0 || end !== text.length - 1) text = text.slice(start, end + 1);
  return text;
}

// jsonMode: "schema" (OpenAI strict json_schema), "object" (json_object), or "none"
// (no response_format at all; the schema in the system prompt does the steering).
function openaiCompatible({ label, keyLabel, hosts, defaults, models, baseUrl, jsonMode = "object" }) {
  return {
    label,
    keyLabel,
    hosts,
    defaults: { baseUrl, maxTokens: 4096, ...defaults },
    models,

    async call({ system, user, schema, settings, opts, timeoutMs }) {
      // The schema is always embedded in the system prompt too, because not
      // every open model honors response_format. Local validation in plan.js
      // (F14) is the real contract.
      const systemWithSchema =
        `${system}\n\nRespond with a single JSON object that matches this JSON Schema exactly:\n` +
        JSON.stringify(schema);

      const responseFormat =
        jsonMode === "schema"
          ? { type: "json_schema", json_schema: { name: "tab_plan", strict: true, schema } }
          : jsonMode === "object"
            ? { type: "json_object" }
            : null;

      const base = {
        model: opts.model,
        max_tokens: opts.maxTokens,
        messages: [
          { role: "system", content: systemWithSchema },
          { role: "user", content: JSON.stringify(user) }
        ]
      };
      if (typeof opts.temperature === "number") base.temperature = opts.temperature;
      if (opts.reasoningEffort) base.reasoning_effort = opts.reasoningEffort;
      // Per-model request extras (for example, turning off thinking mode).
      Object.assign(base, models.find((m) => m.id === opts.model)?.extra || {});

      const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const post = (body) =>
        fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
            body: JSON.stringify(body)
          },
          timeoutMs
        );

      let res = await post(responseFormat ? { ...base, response_format: responseFormat } : base);
      // Some endpoints reject response_format outright. Retry once without it;
      // the schema in the system prompt still steers the output.
      if (res.status === 400 && responseFormat) res = await post(base);
      if (!res.ok) throw new Error(`${label} http ${res.status}`);
      const data = await res.json();
      const choice = data.choices?.[0];
      if (!choice) throw new Error(`${label} no choices`);
      if (choice.finish_reason === "content_filter" || choice.message?.refusal) throw new Error(`${label} refusal`);
      const text = choice.message?.content;
      if (typeof text !== "string") throw new Error(`${label} empty content`);
      return extractJson(text);
    }
  };
}

// Model ids verified on https://platform.openai.com/docs/models, Sep 12 2026.
const openai = openaiCompatible({
  label: "OpenAI",
  keyLabel: "OpenAI API key (sk-...)",
  hosts: ["https://api.openai.com/*"],
  baseUrl: "https://api.openai.com/v1",
  jsonMode: "schema",
  defaults: { model: "gpt-5.6-terra", reasoningEffort: "low" },
  models: [
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (balanced, default)" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (fastest, cheapest)" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (flagship)" },
    { id: "gpt-6-astra", label: "GPT-6 Astra (most capable)" }
  ]
});

// Open models on NVIDIA NIM. Ids copied from NVIDIA's own model list,
// GET https://integrate.api.nvidia.com/v1/models, on Sep 12 2026, then each
// one was called from the extension to measure latency on a small prompt:
//   deepseek-v4-flash (thinking off)  ~0.4 s   default. Hangs if response_format is sent, hence jsonMode "none".
//   nemotron-3-super                   ~1 s
//   gpt-oss-20b                        ~1.6 s
//   glm-5.3-flash                      ~6 s    reasoning_effort "low" trims its thinking but not the latency
//   kimi-k3                            >40 s   listed because people ask for it, but it will hit the fallback
// Left out: deepseek-v4-pro-0813 (deprecated Sep 13 2026), kimi-k2.6 (404 on the free
// endpoint), nemotron-3-ultra and gemma-4-31b (both over 30 s).
const nvidia = openaiCompatible({
  label: "NVIDIA NIM (open models)",
  keyLabel: "NVIDIA API key (nvapi-...)",
  hosts: ["https://integrate.api.nvidia.com/*"],
  baseUrl: "https://integrate.api.nvidia.com/v1",
  jsonMode: "none",
  defaults: { model: "deepseek-ai/deepseek-v4-flash-0731", temperature: 0.2 },
  models: [
    { id: "deepseek-ai/deepseek-v4-flash-0731", label: "DeepSeek V4 Flash (default, fastest)", extra: { chat_template_kwargs: { thinking: false } } },
    { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B (NVIDIA)" },
    { id: "openai/gpt-oss-20b", label: "gpt-oss-20b (OpenAI open weights)" },
    { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash (Z.ai, slower: about 6 s)", extra: { reasoning_effort: "low" } },
    { id: "moonshotai/kimi-k3", label: "Kimi K3 (Moonshot, very slow: over the time budget)" }
  ]
});

export const PROVIDERS = { anthropic, openai, nvidia };

// Resolve the active provider and its effective options from config plus
// any runtime override saved in Settings (settings.provider, settings.model).
export function resolveProvider(settings = {}) {
  const name = settings.provider || MODEL_CONFIG.provider;
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`unknown provider "${name}"`);
  const known = provider.models.map((m) => m.id);
  const opts = {
    ...provider.defaults,
    ...(MODEL_CONFIG.overrides[name] || {}),
    ...(settings.model && known.includes(settings.model) ? { model: settings.model } : {})
  };
  // Keys are stored per provider (settings.apiKeys[name]); settings.apiKey is
  // the pre-per-provider fallback so an existing install keeps working.
  const apiKey = (settings.apiKeys && settings.apiKeys[name]) || settings.apiKey || "";
  return { name, provider, opts, apiKey, timeoutMs: MODEL_CONFIG.timeoutMs };
}
