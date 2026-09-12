// HackyTab Agent side panel (spec 5.2, 5.6, 5.8). State-driven: the worker
// pushes STATE messages, the panel renders them.

import { PROVIDERS } from "./agent/providers.js";
import { MODEL_CONFIG } from "./agent/config.js";

const DEFAULT_SETTINGS = { threshold: 15, repromptDelta: 5, staleHours: 24, provider: "", model: "", apiKey: "", apiKeys: {}, groupingBasis: "task", paused: false };
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

function renderRow(row, listEl) {
  const li = document.createElement("li");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!row.checked;
  cb.dataset.tabId = String(row.tabId);
  const img = document.createElement("img");
  img.src = row.favIconUrl || "icons/icon16.png";
  img.alt = "";
  img.onerror = () => (img.src = "icons/icon16.png");
  const text = document.createElement("div");
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = row.title;
  title.title = row.title;
  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = `${row.domain} · ${row.reason}`;
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
      c.style.background = `var(--${g.color})`;
      c.textContent = g.title;
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
  return settings.provider || MODEL_CONFIG.provider;
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
    if (!el || k === "apiKey") continue;
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v ?? "";
  }
  fillModelSelect();
}

function keyFor(name) {
  return (settings.apiKeys && settings.apiKeys[name]) || settings.apiKey || "";
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
  form.elements.apiKey.value = keyFor(name);
}

async function saveSettings() {
  const form = $("#settings-form");
  const next = { ...settings };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const el = form.elements[k];
    if (!el || k === "apiKey") continue;
    if (el.type === "checkbox") next[k] = el.checked;
    else if (el.type === "number") next[k] = Number(el.value) || DEFAULT_SETTINGS[k];
    else next[k] = el.value.trim();
  }
  next.threshold = Math.min(100, Math.max(5, next.threshold));
  const providerChanged = next.provider !== settings.provider;
  if (providerChanged) next.model = "";
  // The key field belongs to the provider that was showing when it was typed.
  const keyOwner = providerChanged ? effectiveProvider() : next.provider || MODEL_CONFIG.provider;
  next.apiKeys = { ...(settings.apiKeys || {}), [keyOwner]: form.elements.apiKey.value.trim() };
  next.apiKey = "";
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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "STATE" && msg.windowId === windowId) render(msg.payload);
});

(async function init() {
  const win = await chrome.windows.getCurrent();
  windowId = win.id;
  const stored = await chrome.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  fillSettingsForm();
  const res = await send("GET_STATE");
  if (res?.state) render({ ...res.state, closedCount: res.closedCount });
  if (!keyFor(effectiveProvider())) $("#settings").open = true;
})().catch((e) => flash(e.message));
