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
//
// Adding a provider: add an entry to PROVIDERS with { label, keyLabel, hosts, call }.
// `hosts` is documentation only; manifest.json host_permissions must list them
// statically, so add the host there too.

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
// OpenAI-compatible chat completions. Used for NVIDIA NIM (GLM, Kimi, etc.).
// Reusable for any endpoint that speaks POST {baseUrl}/chat/completions.
// --------------------------------------------------------------------------
function openaiCompatible({ label, keyLabel, hosts, defaults }) {
  return {
    label,
    keyLabel,
    hosts,
    defaults,

    async call({ system, user, schema, settings, opts, timeoutMs }) {
      // Not every open model honors json_schema response_format, so the
      // schema is also embedded in the system prompt and json_object mode is
      // requested. Local validation in plan.js (F14) is the real contract.
      const systemWithSchema =
        `${system}\n\nRespond with a single JSON object that matches this JSON Schema exactly:\n` +
        JSON.stringify(schema);

      const body = {
        model: opts.model,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemWithSchema },
          { role: "user", content: JSON.stringify(user) }
        ]
      };
      const res = await fetchWithTimeout(
        `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${settings.apiKey}`
          },
          body: JSON.stringify(body)
        },
        timeoutMs
      );
      if (!res.ok) throw new Error(`${label} http ${res.status}`);
      const data = await res.json();
      const choice = data.choices?.[0];
      if (!choice) throw new Error(`${label} no choices`);
      if (choice.finish_reason === "content_filter") throw new Error(`${label} refusal`);
      let text = choice.message?.content;
      if (typeof text !== "string") throw new Error(`${label} empty content`);
      // Some open models wrap JSON in a markdown fence or emit reasoning first.
      text = text.trim();
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) text = fence[1].trim();
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start > 0 || end !== text.length - 1) text = text.slice(start, end + 1);
      return text;
    }
  };
}

const nvidia = openaiCompatible({
  label: "NVIDIA NIM (open models)",
  keyLabel: "NVIDIA API key (nvapi-...)",
  hosts: ["https://integrate.api.nvidia.com/*"],
  defaults: {
    model: "moonshotai/kimi-k2-instruct",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    temperature: 0.2,
    maxTokens: 4096
  }
});

export const PROVIDERS = { anthropic, nvidia };

// Resolve the active provider and its effective options from config plus
// any runtime override saved in Settings (settings.provider, settings.model).
export function resolveProvider(settings = {}) {
  const name = settings.provider || MODEL_CONFIG.provider;
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`unknown provider "${name}"`);
  const opts = {
    ...provider.defaults,
    ...(MODEL_CONFIG.overrides[name] || {}),
    ...(settings.model ? { model: settings.model } : {})
  };
  return { name, provider, opts, timeoutMs: MODEL_CONFIG.timeoutMs };
}
