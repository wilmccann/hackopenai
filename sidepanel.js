// HackyTab Agent side panel (spec 5.2, 5.6, 5.8). State-driven: the worker
// pushes STATE messages, the panel renders them.

import { PROVIDERS, isKnownProvider } from "./agent/providers.js";
import { MODEL_CONFIG } from "./agent/config.js";
import { COLORS } from "./agent/local.js";

const DEFAULT_SETTINGS = { threshold: 15, repromptDelta: 5, staleHours: 24, provider: "", model: "", apiKeys: {}, groupingBasis: "task", sendPageText: true, paused: false };
const $ = (sel) => document.querySelector(sel);

let windowId = null;
let state = { phase: "idle" };
let settings = { ...DEFAULT_SETTINGS };

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, windowId, payload });
}

function flash(text) {
  const el = $("#flash");
  el.textContent = text;
  el.hidden = !text;
}

// Favicons come from Chrome's own favicon cache via the extension's
// _favicon endpoint ("favicon" permission), never from the icon URL a page
// declares for itself (chrome.tabs.Tab.favIconUrl is not used). That endpoint only accepts http(s) page URLs, makes no network
// request, and cannot be pointed at data:/javascript:/tracking URLs.
const FALLBACK_ICON = "icons/icon16.png";
function faviconFor(pageUrl) {
  if (typeof pageUrl !== "string" || !/^https?:\/\//i.test(pageUrl)) return FALLBACK_ICON;
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=16`);
}

function renderRow(row, listEl) {
  const li = document.createElement("li");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!row.checked;
  cb.dataset.tabId = String(Number.isInteger(row.tabId) ? row.tabId : -1);
  const img = document.createElement("img");
  img.src = faviconFor(row.url);
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  img.onerror = () => {
    img.onerror = null;
    img.src = FALLBACK_ICON;
  };
  const text = document.createElement("div");
  const title = document.createElement("div");
  title.className = "title";
  // All page- and model-derived strings are rendered as text nodes only.
  title.textContent = String(row.title ?? "");
  title.title = String(row.title ?? "");
  const sub = document.createElement("div");
  sub.className = "sub";
  // For duplicates, name the site of the tab that stays open so a keep-swap
  // onto a look-alike host is visible; such rows are never pre-checked.
  const keep = row.keepDomain ? ` · keeps ${String(row.keepDomain)}` : "";
  sub.textContent = `${String(row.domain ?? "")} · ${String(row.reason ?? "")}${keep}`;
  text.append(title, sub);
  li.append(cb, img, text);
  listEl.append(li);
}

function renderList(rows, listEl) {
  listEl.replaceChildren();
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "None found";
    listEl.append(li);
    return;
  }
  rows.forEach((r) => renderRow(r, listEl));
}

function render(next) {
  state = next || state;
  const phase = state.phase || "idle";
  document.querySelectorAll(".phase").forEach((s) => (s.hidden = s.id !== `phase-${phase}`));
  $("#tabcount").textContent = state.count != null ? `${state.count} tabs` : "";

  if (phase === "idle") {
    $("#idle-text").textContent = state.never
      ? "You asked me not to offer help in this window. You can still organize it manually."
      : `This window has ${state.count ?? "?"} tabs. I'll offer to help at ${settings.threshold}.`;
  }
  if (phase === "prompt") {
    $("#prompt-text").textContent = `This window has ${state.count} tabs. Want me to organize them?`;
  }
  if (phase === "review") {
    $("#review-summary").textContent = state.summary || "";
    const chips = $("#review-groups");
    chips.replaceChildren();
    for (const g of state.groups || []) {
      const c = document.createElement("span");
      c.className = "chip";
      // Color is a CSS variable name; only Chrome's own enum values are allowed.
      c.style.background = `var(--${COLORS.includes(g.color) ? g.color : "grey"})`;
      c.textContent = String(g.title ?? "");
      chips.append(c);
    }
    $("#review-source").textContent = state.source && state.source !== "model" ? `Plan source: ${state.source}` : "";
    renderList(state.review?.duplicates || [], $("#list-duplicates"));
    renderList(state.review?.stale || [], $("#list-stale"));
    $("#btn-undo-review").disabled = !state.canUndo;
    $("#btn-redo-review").disabled = !state.canRedo;
  }
  if (phase === "done") {
    $("#done-message").textContent = state.message || "Done.";
    $("#done-summary").textContent = state.summary || "";
    $("#done-reopen").hidden = !(state.closedCount > 0);
    $("#btn-undo-done").disabled = !state.canUndo;
    $("#btn-redo-done").disabled = !state.canRedo;
  }
  if (phase === "error") {
    $("#error-message").textContent = state.message || "Something went wrong.";
  }
  if (phase !== "done" && phase !== "review") flash("");
  else flash(state.message && phase === "review" ? state.message : "");
}

async function onAction(action) {
  if (action === "CONFIRM_CLOSE") {
    const tabIds = [...document.querySelectorAll("#phase-review input[type=checkbox]:checked")].map((cb) => Number(cb.dataset.tabId));
    await send("CONFIRM_CLOSE", { tabIds });
    return;
  }
  if (action === "OPEN_DEMO") {
    const res = await send("OPEN_DEMO");
    flash(res?.error ? res.error : `Opened demo window with ${res.count} tabs.`);
    return;
  }
  const res = await send(action);
  if (res?.error) flash(res.error);
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  e.preventDefault();
  onAction(el.dataset.action).catch((err) => flash(err.message));
});

document.addEventListener("keydown", (e) => {
  if (e.altKey && e.shiftKey && e.code === "KeyD") {
    $("#dev").hidden = !$("#dev").hidden;
  }
});

// ---------------------------------------------------------------------------
// Settings (F28, F29)
// ---------------------------------------------------------------------------
function effectiveProvider() {
  return isKnownProvider(settings.provider) ? settings.provider : MODEL_CONFIG.provider;
}

function fillSettingsForm() {
  const form = $("#settings-form");
  const sel = form.elements.provider;
  sel.replaceChildren();
  const def = document.createElement("option");
  def.value = "";
  def.textContent = `Default from agent/config.js (${PROVIDERS[MODEL_CONFIG.provider]?.label || MODEL_CONFIG.provider})`;
  sel.append(def);
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = p.label;
    sel.append(o);
  }
  for (const [k, v] of Object.entries(settings)) {
    const el = form.elements[k];
    if (!el || k === "apiKey" || k === "apiKeys") continue;
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v ?? "";
  }
  fillModelSelect();
}

function keyFor(name) {
  const keys = settings.apiKeys && typeof settings.apiKeys === "object" ? settings.apiKeys : {};
  return (Object.hasOwn(keys, name) && keys[name]) || "";
}

// The stored key is never written back into the DOM (L1). The field is shown
// empty; the panel only reports that a key exists and its last 4 characters.
// A key is written to storage only when the user types one.
let replacingKey = false;
function renderKeyStatus() {
  const form = $("#settings-form");
  const key = keyFor(effectiveProvider());
  const input = form.elements.apiKey;
  input.value = "";
  const has = !!key;
  $("#apikey-status").textContent = has ? `Key set (…${key.length > 8 ? key.slice(-4) : "****"})` : "No key set";
  input.hidden = has && !replacingKey;
  $("#btn-key-replace").hidden = !has || replacingKey;
  $("#btn-key-clear").hidden = !has;
}

// The model dropdown only ever shows the selected provider's models (F28).
function fillModelSelect() {
  const form = $("#settings-form");
  const name = effectiveProvider();
  const p = PROVIDERS[name];
  $("#apikey-label").textContent = p?.keyLabel || "API key";
  const sel = form.elements.model;
  sel.replaceChildren();
  const defaultId = MODEL_CONFIG.overrides[name]?.model || p?.defaults?.model || "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = `Provider default (${defaultId})`;
  sel.append(def);
  for (const m of p?.models || []) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.label;
    sel.append(o);
  }
  const known = (p?.models || []).some((m) => m.id === settings.model);
  sel.value = known ? settings.model : "";
  renderKeyStatus();
}

async function saveSettings() {
  const form = $("#settings-form");
  const next = { ...settings };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const el = form.elements[k];
    if (!el || k === "apiKeys") continue;
    if (el.type === "checkbox") next[k] = el.checked;
    else if (el.type === "number") next[k] = Number(el.value) || DEFAULT_SETTINGS[k];
    else next[k] = el.value.trim();
  }
  next.threshold = Math.min(100, Math.max(5, next.threshold));
  // Provider ids are whitelisted; anything else falls back to the config default ("").
  if (next.provider && !isKnownProvider(next.provider)) next.provider = "";
  if (!["task", "website"].includes(next.groupingBasis)) next.groupingBasis = "task";
  const providerChanged = next.provider !== settings.provider;
  if (providerChanged) next.model = "";
  // The key field belongs to the provider that was showing when it was typed.
  // An empty field means "leave the stored key alone", never "clear it";
  // clearing is the explicit Clear button.
  const keyOwner = providerChanged ? effectiveProvider() : next.provider || MODEL_CONFIG.provider;
  const apiKeys = {};
  for (const name of Object.keys(PROVIDERS)) if (settings.apiKeys?.[name]) apiKeys[name] = settings.apiKeys[name];
  const typed = form.elements.apiKey.value.trim();
  if (typed) apiKeys[keyOwner] = typed;
  next.apiKeys = apiKeys;
  delete next.apiKey; // legacy single-key field is never written again (N4)
  replacingKey = false;
  settings = next;
  await chrome.storage.local.set({ settings });
  fillSettingsForm();
  await send("SETTINGS_CHANGED");
  render(state);
}

$("#settings-form").addEventListener("change", () => saveSettings().catch((e) => flash(e.message)));
$("#btn-reset-never").addEventListener("click", async () => {
  await send("RESET_NEVER");
  flash("Cleared the Never list.");
});
$("#btn-forget-run").addEventListener("click", async () => {
  await send("FORGET_LAST_RUN");
  flash("Forgot the last run: cached plan, snapshot, and closed-tab list are gone.");
});
$("#btn-key-replace").addEventListener("click", () => {
  replacingKey = true;
  renderKeyStatus();
  $("#settings-form").elements.apiKey.focus();
});
$("#btn-key-clear").addEventListener("click", async () => {
  const name = effectiveProvider();
  const apiKeys = { ...(settings.apiKeys && typeof settings.apiKeys === "object" ? settings.apiKeys : {}) };
  delete apiKeys[name];
  settings = { ...settings, apiKeys };
  delete settings.apiKey;
  await chrome.storage.local.set({ settings });
  replacingKey = false;
  fillSettingsForm();
  flash(`Cleared the ${PROVIDERS[name]?.keyLabel || "API key"}.`);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Only accept STATE pushes from this extension's own service worker.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender || sender.id !== chrome.runtime.id || sender.tab) return;
  if (msg?.type === "STATE" && msg.windowId === windowId && msg.payload && typeof msg.payload === "object") render(msg.payload);
});

(async function init() {
  const win = await chrome.windows.getCurrent();
  windowId = win.id;
  const stored = await chrome.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  delete settings.apiKey; // pre-migration field, if any: never read, never re-saved
  fillSettingsForm();
  const res = await send("GET_STATE");
  if (res?.state) render({ ...res.state, closedCount: res.closedCount });
  if (!keyFor(effectiveProvider())) $("#settings").open = true;
})().catch((e) => flash(e.message));
