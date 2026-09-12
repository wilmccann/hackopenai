// HackyTab Agent service worker (spec sections 5, 9).
// Counting, threshold detection, messaging, plan application, undo/redo.

import { planTabs } from "./agent/plan.js";
import {
  findDuplicates,
  findStale,
  domainFallbackPlan,
  mergeUnassignedByDomain,
  registrableDomain,
  hostOf,
  GROUP_NONE
} from "./agent/local.js";
import { openDemoWindow } from "./demo/open-demo.js";

export const DEFAULT_SETTINGS = {
  threshold: 15,
  repromptDelta: 5,
  staleHours: 24,
  provider: "",
  model: "",
  apiKey: "",
  apiKeys: {},
  groupingBasis: "task",
  paused: false
};

const EXCERPT_TIMEOUT_MS = 1500;

// ---------------------------------------------------------------------------
// Storage (spec section 9, "State in chrome.storage.local")
// ---------------------------------------------------------------------------
async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function getWindowsState() {
  const { windows } = await chrome.storage.local.get("windows");
  return windows || {};
}
async function patchWindowState(windowId, patch) {
  const windows = await getWindowsState();
  windows[windowId] = { ...(windows[windowId] || {}), ...patch };
  await chrome.storage.local.set({ windows });
}
async function getLastRun() {
  const { lastRun } = await chrome.storage.local.get("lastRun");
  return lastRun || null;
}
async function setLastRun(lastRun) {
  await chrome.storage.local.set({ lastRun });
}

// Per-window panel state lives in session storage so it survives worker restarts.
async function getState(windowId) {
  const key = `state:${windowId}`;
  const r = await chrome.storage.session.get(key);
  return r[key] || { phase: "idle", windowId };
}
async function setState(windowId, patch, { replace = false } = {}) {
  const prev = replace ? {} : await getState(windowId);
  const state = { ...prev, ...patch, windowId };
  await chrome.storage.session.set({ [`state:${windowId}`]: state });
  chrome.runtime.sendMessage({ type: "STATE", windowId, payload: state }).catch(() => {});
  return state;
}

// ---------------------------------------------------------------------------
// Detection (F1 to F5)
// ---------------------------------------------------------------------------
async function countTabs(windowId) {
  return (await chrome.tabs.query({ windowId })).length;
}

async function evaluateWindow(windowId) {
  let win;
  try {
    win = await chrome.windows.get(windowId);
  } catch {
    return;
  }
  if (win.incognito || win.type !== "normal") return; // F5
  const settings = await getSettings();
  if (settings.paused) return; // F4
  const ws = (await getWindowsState())[windowId] || {};
  if (ws.never) return; // F4
  const count = await countTabs(windowId);
  if (count < settings.threshold) return;
  if (ws.lastPromptedCount != null && count < ws.lastPromptedCount + settings.repromptDelta) return; // F3
  const state = await getState(windowId);
  if (state.phase !== "idle" && state.phase !== "done") return; // already engaged
  await promptWindow(windowId, count);
}

async function promptWindow(windowId, count) {
  await patchWindowState(windowId, { lastPromptedCount: count });
  await setState(windowId, { phase: "prompt", count }, { replace: true });
  try {
    await chrome.sidePanel.open({ windowId }); // F6
  } catch (e) {
    // F6 fallback: badge plus toast, toolbar click opens the panel.
    console.warn("sidePanel.open failed, using badge fallback:", e.message);
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setBadgeText({ text: String(count) });
    chrome.notifications.create(`hackytab-${windowId}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "HackyTab Agent",
      message: `This window has ${count} tabs. Click the HackyTab icon to organize them.`
    });
  }
}

chrome.tabs.onCreated.addListener((tab) => evaluateWindow(tab.windowId));
chrome.tabs.onAttached.addListener((_tabId, info) => evaluateWindow(info.newWindowId));
chrome.tabs.onRemoved.addListener(async (_tabId, info) => {
  if (info.isWindowClosing) return;
  const state = await getState(info.windowId);
  if (state.phase === "prompt" || state.phase === "idle") {
    setState(info.windowId, { count: await countTabs(info.windowId) }).catch(() => {});
  }
});
chrome.tabs.onDetached.addListener(async (_tabId, info) => {
  const state = await getState(info.oldWindowId);
  if (state.phase === "prompt" || state.phase === "idle") {
    setState(info.oldWindowId, { count: await countTabs(info.oldWindowId) }).catch(() => {});
  }
});
chrome.windows.onRemoved.addListener(async (windowId) => {
  await chrome.storage.session.remove(`state:${windowId}`);
  const windows = await getWindowsState();
  if (windows[windowId]) {
    delete windows[windowId];
    await chrome.storage.local.set({ windows });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.notifications.onClicked.addListener(async (id) => {
  const windowId = Number(id.replace("hackytab-", ""));
  chrome.notifications.clear(id);
  try {
    await chrome.windows.update(windowId, { focused: true });
    await chrome.sidePanel.open({ windowId });
  } catch {}
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "replay-last-plan") return;
  const win = await chrome.windows.getLastFocused();
  replay(win.id).catch((e) => setState(win.id, { phase: "error", message: e.message }));
});

// ---------------------------------------------------------------------------
// Collection (F9, F10)
// ---------------------------------------------------------------------------
function toTabRecord(t) {
  return {
    id: t.id,
    index: t.index,
    title: t.title || "",
    url: t.url || t.pendingUrl || "",
    pinned: !!t.pinned,
    audible: !!t.audible,
    discarded: !!t.discarded,
    lastAccessed: t.lastAccessed,
    groupId: t.groupId ?? GROUP_NONE,
    favIconUrl: t.favIconUrl || "",
    excerpt: ""
  };
}

async function collectExcerpt(tab) {
  if (tab.discarded || !/^https?:/i.test(tab.url)) return "";
  const timeout = new Promise((resolve) => setTimeout(() => resolve(""), EXCERPT_TIMEOUT_MS));
  const inject = chrome.scripting
    .executeScript({ target: { tabId: tab.id }, files: ["content/excerpt.js"] })
    .then((r) => (typeof r?.[0]?.result === "string" ? r[0].result : ""))
    .catch(() => "");
  return Promise.race([inject, timeout]);
}

async function collectTabs(windowId) {
  const rawTabs = await chrome.tabs.query({ windowId });
  const tabs = rawTabs.map(toTabRecord);
  const excerpts = await Promise.all(tabs.map(collectExcerpt));
  tabs.forEach((t, i) => (t.excerpt = excerpts[i])); // N5: sent to the model, not stored
  return { rawTabs, tabs };
}

// ---------------------------------------------------------------------------
// Apply, snapshot, review (F16 to F21)
// ---------------------------------------------------------------------------
async function takeSnapshot(windowId, rawTabs) {
  const groups = {};
  for (const g of await chrome.tabGroups.query({ windowId })) {
    groups[g.id] = { title: g.title || "", color: g.color, collapsed: !!g.collapsed };
  }
  const tabs = {};
  for (const t of rawTabs) tabs[t.id] = t.groupId ?? GROUP_NONE;
  return { tabs, groups };
}

async function applyPlan(windowId, plan, rawTabs) {
  const byId = new Map(rawTabs.map((t) => [t.id, t]));
  const pinnedCount = rawTabs.filter((t) => t.pinned).length;
  const created = [];
  for (const group of plan.groups) {
    const tabIds = plan.assignments
      .filter((a) => a.group_key === group.key)
      .map((a) => a.tab_id)
      .filter((id) => byId.has(id) && !byId.get(id).pinned); // F18
    if (tabIds.length === 0) continue;
    try {
      const gid = await chrome.tabs.group({ tabIds, createProperties: { windowId } }); // F17
      await chrome.tabGroups.update(gid, { title: group.title, color: group.color, collapsed: false });
      created.push(gid);
    } catch (e) {
      console.warn("group failed:", group.key, e.message);
    }
  }
  // F19: moving each group to the first non-pinned slot in reverse order yields plan order.
  for (const gid of [...created].reverse()) {
    try {
      await chrome.tabGroups.move(gid, { index: pinnedCount });
    } catch (e) {
      console.warn("move failed:", gid, e.message);
    }
  }
  return created;
}

function buildReview(plan, tabs) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const row = (id, reason, checked) => {
    const t = byId.get(id);
    if (!t) return null;
    return { tabId: id, title: t.title || t.url, domain: registrableDomain(hostOf(t.url)), favIconUrl: t.favIconUrl, reason, checked };
  };
  const duplicates = plan.duplicates
    .map((d) => row(d.tab_id, d.reason || `Same page as "${byId.get(d.keep_tab_id)?.title || "another tab"}"`, true))
    .filter(Boolean);
  const dupIds = new Set(duplicates.map((r) => r.tabId));
  const stale = plan.stale
    .filter((s) => !dupIds.has(s.tab_id))
    .map((s) => row(s.tab_id, s.reason || "Not opened in a while", false))
    .filter(Boolean);
  return { duplicates, stale };
}

async function finishRun(windowId, plan, rawTabs, tabs, source) {
  const snapshot = await takeSnapshot(windowId, rawTabs); // F16
  const createdGroupIds = await applyPlan(windowId, plan, rawTabs);
  const previous = await getLastRun();
  const closed = previous && previous.windowId === windowId ? previous.closed || [] : [];
  await setLastRun({ windowId, snapshot, plan, createdGroupIds, closed, undone: false, at: Date.now() });
  await patchWindowState(windowId, { lastPromptedCount: rawTabs.length });
  const review = buildReview(plan, tabs);
  return setState(windowId, {
    phase: "review",
    count: rawTabs.length,
    summary: plan.summary,
    groups: plan.groups.map((g) => ({ title: g.title, color: g.color })),
    review,
    source,
    canUndo: true,
    canRedo: false,
    closedCount: closed.length,
    message: ""
  }, { replace: true });
}

// ---------------------------------------------------------------------------
// Organize (F9 to F20)
// ---------------------------------------------------------------------------
async function organize(windowId) {
  const settings = await getSettings();
  await setState(windowId, { phase: "planning", count: await countTabs(windowId) }, { replace: true });
  const { rawTabs, tabs } = await collectTabs(windowId);
  const duplicates = findDuplicates(tabs); // F11
  const stale = findStale(tabs, settings.staleHours); // F12

  let plan;
  let source = "model";
  try {
    plan = await planTabs(tabs, settings, { duplicates, stale }); // F13, F14
  } catch (e) {
    console.warn("planTabs failed, using domain fallback:", e.message);
    plan = domainFallbackPlan(tabs, { duplicates, stale }); // F20
    source = `fallback: ${e.message}`;
  }
  plan = mergeUnassignedByDomain(plan, tabs); // section 6, option C
  await finishRun(windowId, plan, rawTabs, tabs, source);
}

// ---------------------------------------------------------------------------
// Close, reopen (F22 to F24)
// ---------------------------------------------------------------------------
async function closeTabs(windowId, tabIds) {
  const run = (await getLastRun()) || { windowId, closed: [] };
  const byId = new Map((await chrome.tabs.query({ windowId })).map((t) => [t.id, t]));
  const closing = (tabIds || []).map((id) => byId.get(id)).filter((t) => t && !t.pinned);
  run.closed = [...(run.closed || []), ...closing.map((t) => ({ url: t.url, title: t.title }))];
  await setLastRun(run);
  if (closing.length) await chrome.tabs.remove(closing.map((t) => t.id));
  await setState(windowId, {
    phase: "done",
    count: await countTabs(windowId),
    message: closing.length ? `Closed ${closing.length} tab${closing.length === 1 ? "" : "s"}.` : "Nothing closed.",
    closedCount: run.closed.length
  });
}

async function reopenClosed(windowId) {
  const run = await getLastRun();
  if (!run || !run.closed?.length) return;
  const closed = run.closed;
  run.closed = [];
  await setLastRun(run);
  for (const c of closed) {
    try {
      await chrome.tabs.create({ windowId, url: c.url, active: false });
    } catch {}
  }
  await setState(windowId, { message: `Reopened ${closed.length} tab${closed.length === 1 ? "" : "s"}.`, closedCount: 0, count: await countTabs(windowId) });
}

// ---------------------------------------------------------------------------
// Undo, redo, replay (F25 to F27, N3)
// ---------------------------------------------------------------------------
async function undo() {
  const run = await getLastRun();
  if (!run || run.undone) return;
  const { windowId, snapshot } = run;
  const current = await chrome.tabs.query({ windowId });
  const alive = new Set(current.map((t) => t.id));
  const createdSet = new Set(run.createdGroupIds || []);

  const toUngroup = current.filter((t) => createdSet.has(t.groupId)).map((t) => t.id);
  if (toUngroup.length) await chrome.tabs.ungroup(toUngroup);

  const byOriginalGroup = new Map();
  for (const [tabId, gid] of Object.entries(snapshot.tabs)) {
    const id = Number(tabId);
    if (gid === GROUP_NONE || !alive.has(id)) continue;
    if (!byOriginalGroup.has(gid)) byOriginalGroup.set(gid, []);
    byOriginalGroup.get(gid).push(id);
  }
  for (const [gid, tabIds] of byOriginalGroup) {
    const meta = snapshot.groups[gid] || {};
    let exists = false;
    try {
      await chrome.tabGroups.get(gid);
      exists = true;
    } catch {}
    try {
      if (exists) {
        await chrome.tabs.group({ tabIds, groupId: gid });
      } else {
        const ng = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        await chrome.tabGroups.update(ng, { title: meta.title || "", color: meta.color || "grey", collapsed: !!meta.collapsed });
      }
    } catch (e) {
      console.warn("restore group failed:", gid, e.message);
    }
  }
  run.undone = true;
  run.createdGroupIds = [];
  await setLastRun(run);
  await setState(windowId, { canUndo: false, canRedo: true, message: "Undo complete. Groups restored to how they were." });
}

async function redo() {
  const run = await getLastRun();
  if (!run || !run.undone) return;
  const rawTabs = await chrome.tabs.query({ windowId: run.windowId });
  run.createdGroupIds = await applyPlan(run.windowId, run.plan, rawTabs);
  run.undone = false;
  await setLastRun(run);
  await setState(run.windowId, { canUndo: true, canRedo: false, message: "Plan re-applied." });
}

async function replay(windowId) {
  const run = await getLastRun();
  if (!run) throw new Error("No cached plan yet. Run Organize once while online.");
  const { rawTabs, tabs } = await collectTabsWithoutExcerpts(windowId);
  const alive = new Set(rawTabs.map((t) => t.id));
  if (!run.plan.assignments.some((a) => alive.has(a.tab_id))) {
    throw new Error("The cached plan does not match this window's tabs.");
  }
  await finishRun(windowId, run.plan, rawTabs, tabs, "replay");
}

async function collectTabsWithoutExcerpts(windowId) {
  const rawTabs = await chrome.tabs.query({ windowId });
  return { rawTabs, tabs: rawTabs.map(toTabRecord) };
}

// ---------------------------------------------------------------------------
// Messaging (spec section 9)
// ---------------------------------------------------------------------------
async function handleMessage({ type, windowId, payload }) {
  switch (type) {
    case "GET_STATE": {
      await chrome.action.setBadgeText({ text: "" }).catch(() => {});
      const state = await getState(windowId);
      if (state.phase === "idle") state.count = await countTabs(windowId);
      const run = await getLastRun();
      return { state, hasCachedPlan: !!run, closedCount: run?.windowId === windowId ? run.closed?.length || 0 : 0 };
    }
    case "ORGANIZE":
      organize(windowId).catch((e) => setState(windowId, { phase: "error", message: e.message }));
      return { ok: true };
    case "DISMISS": // F8, Not now
      await setState(windowId, { phase: "idle", count: await countTabs(windowId) }, { replace: true });
      return { ok: true };
    case "NEVER": // F8
      await patchWindowState(windowId, { never: true });
      await setState(windowId, { phase: "idle", never: true, count: await countTabs(windowId) }, { replace: true });
      return { ok: true };
    case "CONFIRM_CLOSE": // F22
      await closeTabs(windowId, payload?.tabIds || []);
      return { ok: true };
    case "SKIP_CLOSE": // F24
      await setState(windowId, { phase: "done", message: "Left everything open." });
      return { ok: true };
    case "REOPEN": // F23
      await reopenClosed(windowId);
      return { ok: true };
    case "UNDO":
      await undo();
      return { ok: true };
    case "REDO":
      await redo();
      return { ok: true };
    case "REPLAY":
      replay(windowId).catch((e) => setState(windowId, { phase: "error", message: e.message }));
      return { ok: true };
    case "SETTINGS_CHANGED": // F29: settings are read fresh on every use; re-check windows now.
      for (const w of await chrome.windows.getAll({ windowTypes: ["normal"] })) evaluateWindow(w.id).catch(() => {});
      return { ok: true };
    case "RESET_NEVER": {
      const windows = await getWindowsState();
      for (const k of Object.keys(windows)) delete windows[k].never;
      await chrome.storage.local.set({ windows });
      return { ok: true };
    }
    case "OPEN_DEMO": {
      const settings = await getSettings();
      const result = await openDemoWindow({
        // Prompt after the presenter opens two more tabs by hand (section 11, step 2).
        onWindowCreated: (wid, total) => patchWindowState(wid, { lastPromptedCount: total + 2 - settings.repromptDelta })
      });
      return { ok: true, ...result };
    }
    default:
      return { error: `unknown message type ${type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;
  handleMessage(msg).then(sendResponse, (e) => sendResponse({ error: e.message }));
  return true;
});
