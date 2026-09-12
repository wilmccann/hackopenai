// HackyTab Agent service worker (spec sections 5, 9).
// Counting, threshold detection, messaging, plan application, undo/redo.

import { planTabs, sanitizeText, sameDomain, LIMITS } from "./agent/plan.js";
import {
  findDuplicates,
  findStale,
  domainFallbackPlan,
  mergeUnassignedByDomain,
  registrableDomain,
  hostOf,
  fingerprintTabs,
  remapPlan,
  COLORS,
  GROUP_NONE
} from "./agent/local.js";
import { MODEL_CONFIG } from "./agent/config.js";
import { openDemoWindow } from "./demo/open-demo.js";

export const DEFAULT_SETTINGS = {
  threshold: 15,
  repromptDelta: 5,
  staleHours: 24,
  provider: "",
  model: "",
  apiKeys: {},
  groupingBasis: "task",
  sendPageText: true,
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
async function forgetLastRun() {
  await chrome.storage.local.remove("lastRun");
  await chrome.storage.session.remove("closed");
}

// The list of tabs closed through the review checklist (F22, F23) is browsing
// history, so it lives in chrome.storage.session: it is gone when Chrome exits
// and is never written to disk. It is keyed to one window.
async function getClosed(windowId) {
  const { closed } = await chrome.storage.session.get("closed");
  return closed && closed.windowId === windowId && Array.isArray(closed.items) ? closed.items : [];
}
async function setClosed(windowId, items) {
  await chrome.storage.session.set({ closed: { windowId, items } });
}

// F5: incognito windows are never organized, never scripted, and nothing
// about them is written to storage.local. Every handler that acts on a window
// goes through this first.
async function assertNormalWindow(windowId) {
  let win;
  try {
    win = await chrome.windows.get(windowId);
  } catch {
    throw new Error("That window is no longer open.");
  }
  if (win.incognito) throw new Error("HackyTab does not organize incognito windows.");
  if (win.type !== "normal") throw new Error("HackyTab only organizes normal browser windows.");
  return win;
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
  // The cached plan and closed-tab list belong to this window only (M4).
  const run = await getLastRun();
  if (run && run.windowId === windowId) await forgetLastRun();
  const { closed } = await chrome.storage.session.get("closed");
  if (closed && closed.windowId === windowId) await chrome.storage.session.remove("closed");
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    return;
  }
  // One-time migration of the pre-per-provider settings.apiKey. It was typed
  // for the provider configured at the time (MODEL_CONFIG.provider), so it
  // goes into that slot only, and only if that slot is empty. The legacy
  // field is then deleted; nothing reads it any more (spec N4).
  if (Object.hasOwn(settings, "apiKey")) {
    const next = { ...settings };
    const legacy = typeof next.apiKey === "string" ? next.apiKey.trim() : "";
    const apiKeys = next.apiKeys && typeof next.apiKeys === "object" ? { ...next.apiKeys } : {};
    if (legacy && !apiKeys[MODEL_CONFIG.provider]) apiKeys[MODEL_CONFIG.provider] = legacy;
    next.apiKeys = apiKeys;
    delete next.apiKey;
    await chrome.storage.local.set({ settings: next });
  }
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
  if (win.incognito || win.type !== "normal") return; // F5: silently ignore, no state written
  replay(win.id).catch((e) => setState(win.id, { phase: "error", message: sanitizeText(e.message, 300) }));
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

// Excerpts are only collected for tabs the plan can actually act on. Pinned
// tabs are never grouped or closed, and tabs already in a group are neither
// stale candidates nor moved, so their page text would leave the browser for
// nothing. The user can turn page text off entirely in Settings.
async function collectExcerpt(tab, settings) {
  if (settings.sendPageText === false) return "";
  if (tab.pinned || (tab.groupId != null && tab.groupId !== GROUP_NONE)) return "";
  if (tab.discarded || !/^https?:/i.test(tab.url)) return "";
  const timeout = new Promise((resolve) => setTimeout(() => resolve(""), EXCERPT_TIMEOUT_MS));
  const inject = chrome.scripting
    .executeScript({ target: { tabId: tab.id }, files: ["content/excerpt.js"] })
    .then((r) => (typeof r?.[0]?.result === "string" ? r[0].result : ""))
    .catch(() => "");
  return Promise.race([inject, timeout]);
}

async function collectTabs(windowId, settings) {
  const rawTabs = await chrome.tabs.query({ windowId });
  const tabs = rawTabs.map(toTabRecord);
  const excerpts = await Promise.all(tabs.map((t) => collectExcerpt(t, settings)));
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
      const title = sanitizeText(group.title, LIMITS.groupTitle) || "Group";
      const color = COLORS.includes(group.color) ? group.color : "grey";
      await chrome.tabGroups.update(gid, { title, color, collapsed: false });
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
    // No favIconUrl: it is page-controlled. The panel asks Chrome's favicon
    // cache for `url` instead (see sidepanel.js faviconFor).
    return {
      tabId: id,
      title: sanitizeText(t.title, LIMITS.title) || sanitizeText(t.url, LIMITS.url),
      url: /^https?:/i.test(t.url) ? t.url : "",
      domain: registrableDomain(hostOf(t.url)),
      reason: sanitizeText(reason, LIMITS.reason),
      checked
    };
  };
  // A duplicate row is pre-checked only when the surviving tab is on the same
  // site as the one being closed (H1). Anything else is shown unchecked.
  const duplicates = plan.duplicates
    .map((d) => {
      const keep = byId.get(d.keep_tab_id);
      const t = byId.get(d.tab_id);
      const r = row(d.tab_id, d.reason || `Same page as "${keep?.title || "another tab"}"`, !!keep && sameDomain(t, keep));
      if (r && keep) r.keepDomain = registrableDomain(hostOf(keep.url));
      return r;
    })
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
  // N5: lastRun holds only what undo/redo/replay need (snapshot of group ids,
  // the plan, created group ids, URL fingerprints). `tabs` with excerpts is
  // dropped here and never written to storage; the closed-tab list lives in
  // storage.session (getClosed). Tabs are fingerprinted by normalized URL so replay (N3) can find them
  // again after Chrome has handed out new tab ids.
  const closed = await getClosed(windowId);
  await setLastRun({ windowId, snapshot, plan, createdGroupIds, fingerprints: fingerprintTabs(tabs), undone: false, at: Date.now() });
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
  const { rawTabs, tabs } = await collectTabs(windowId, settings);
  const duplicates = findDuplicates(tabs); // F11
  const stale = findStale(tabs, settings.staleHours); // F12

  let plan;
  let source = "model";
  try {
    plan = await planTabs(tabs, settings, { duplicates, stale }); // F13, F14
  } catch (e) {
    console.warn("planTabs failed, using domain fallback:", e.message);
    plan = domainFallbackPlan(tabs, { duplicates, stale }); // F20
    source = `fallback: ${sanitizeText(e.message, 300)}`;
  }
  plan = mergeUnassignedByDomain(plan, tabs); // section 6, option C
  await finishRun(windowId, plan, rawTabs, tabs, source);
}

// ---------------------------------------------------------------------------
// Close, reopen (F22 to F24)
// ---------------------------------------------------------------------------
// Only tabs the last run listed as duplicate or stale, in the window that run
// belongs to, can be closed here (L3). The panel is trusted, but the worker
// re-derives the allowed set rather than closing whatever ids arrive.
async function closeTabs(windowId, tabIds) {
  const run = await getLastRun();
  if (!run || run.windowId !== windowId) throw new Error("The last plan belongs to a different window. Run Organize here first.");
  const listed = new Set([...run.plan.duplicates.map((d) => d.tab_id), ...run.plan.stale.map((s) => s.tab_id)]);
  const byId = new Map((await chrome.tabs.query({ windowId })).map((t) => [t.id, t]));
  const closing = (tabIds || []).map((id) => byId.get(id)).filter((t) => t && !t.pinned && listed.has(t.id));
  const closed = [...(await getClosed(windowId)), ...closing.map((t) => ({ url: t.url, title: t.title }))];
  await setClosed(windowId, closed);
  if (closing.length) await chrome.tabs.remove(closing.map((t) => t.id));
  await setState(windowId, {
    phase: "done",
    count: await countTabs(windowId),
    message: closing.length ? `Closed ${closing.length} tab${closing.length === 1 ? "" : "s"}.` : "Nothing closed.",
    closedCount: closed.length
  });
}

// Closed tabs go back into the window they were closed from, never another.
async function reopenClosed(windowId) {
  const closed = await getClosed(windowId);
  if (!closed.length) throw new Error("No tabs from this window to reopen.");
  await chrome.storage.session.remove("closed");
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
async function undo(requestingWindowId) {
  const run = await getLastRun();
  if (!run || run.undone) return;
  if (run.windowId !== requestingWindowId) throw new Error("The last plan belongs to a different window.");
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

async function redo(requestingWindowId) {
  const run = await getLastRun();
  if (!run || !run.undone) return;
  if (run.windowId !== requestingWindowId) throw new Error("The last plan belongs to a different window.");
  const rawTabs = await chrome.tabs.query({ windowId: run.windowId });
  run.createdGroupIds = await applyPlan(run.windowId, run.plan, rawTabs);
  run.undone = false;
  await setLastRun(run);
  await setState(run.windowId, { canUndo: true, canRedo: false, message: "Plan re-applied." });
}

// N3. Tab ids are not stable across browser sessions, so the cached plan is
// matched to the current window by URL fingerprint. Entries whose tab is gone
// are dropped; if fewer than half of the plan's tabs are found, the plan is
// judged to belong to some other set of tabs and replay is refused.
async function replay(windowId) {
  const run = await getLastRun();
  if (!run) throw new Error("No cached plan yet. Run Organize once while online.");
  const { rawTabs, tabs } = await collectTabsWithoutExcerpts(windowId);
  const { plan, matched, total } = remapPlan(run.plan, run.fingerprints || {}, tabs);
  if (total === 0 || matched * 2 < total) {
    throw new Error(`The cached plan does not match this window's tabs (${matched} of ${total} found).`);
  }
  await finishRun(windowId, plan, rawTabs, tabs, "replay");
}

async function collectTabsWithoutExcerpts(windowId) {
  const rawTabs = await chrome.tabs.query({ windowId });
  return { rawTabs, tabs: rawTabs.map(toTabRecord) };
}

// ---------------------------------------------------------------------------
// Messaging (spec section 9)
// ---------------------------------------------------------------------------
// Message types that act on a window's tabs or on stored run data. Each is
// refused for incognito and non-normal windows before any work happens (M3).
const WINDOW_ACTIONS = new Set(["ORGANIZE", "REPLAY", "CONFIRM_CLOSE", "REOPEN", "UNDO", "REDO"]);

async function handleMessage({ type, windowId, payload }) {
  if (WINDOW_ACTIONS.has(type)) await assertNormalWindow(windowId);
  switch (type) {
    case "GET_STATE": {
      await chrome.action.setBadgeText({ text: "" }).catch(() => {});
      const state = await getState(windowId);
      if (state.phase === "idle") state.count = await countTabs(windowId);
      const run = await getLastRun();
      return { state, hasCachedPlan: !!run, closedCount: (await getClosed(windowId)).length };
    }
    case "ORGANIZE":
      organize(windowId).catch((e) => setState(windowId, { phase: "error", message: sanitizeText(e.message, 300) }));
      return { ok: true };
    case "DISMISS": // F8, Not now
      await setState(windowId, { phase: "idle", count: await countTabs(windowId) }, { replace: true });
      return { ok: true };
    case "NEVER": // F8
      await patchWindowState(windowId, { never: true });
      await setState(windowId, { phase: "idle", never: true, count: await countTabs(windowId) }, { replace: true });
      return { ok: true };
    case "CONFIRM_CLOSE": // F22
      await closeTabs(windowId, (Array.isArray(payload?.tabIds) ? payload.tabIds : []).filter(Number.isInteger));
      return { ok: true };
    case "SKIP_CLOSE": // F24
      await setState(windowId, { phase: "done", message: "Left everything open." });
      return { ok: true };
    case "REOPEN": // F23
      await reopenClosed(windowId);
      return { ok: true };
    case "UNDO":
      await undo(windowId);
      return { ok: true };
    case "REDO":
      await redo(windowId);
      return { ok: true };
    case "FORGET_LAST_RUN": { // Settings button: wipe the cached plan, snapshot, and closed-tab list.
      const run = await getLastRun();
      await forgetLastRun();
      if (run) await setState(run.windowId, { canUndo: false, canRedo: false, closedCount: 0 });
      return { ok: true };
    }
    case "REPLAY":
      replay(windowId).catch((e) => setState(windowId, { phase: "error", message: sanitizeText(e.message, 300) }));
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

// Only this extension's own pages (side panel) may drive the worker. Messages
// from other extensions, from content scripts (sender.tab is set), or from any
// non-extension URL are ignored. There is no externally_connectable entry in
// the manifest, so web pages cannot reach onMessage at all; this is the second
// line of defense.
function isTrustedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (sender.tab || sender.frameId) return false;
  const origin = chrome.runtime.getURL("");
  return typeof sender.url === "string" && sender.url.startsWith(origin);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isTrustedSender(sender)) return false;
  if (!msg || typeof msg.type !== "string") return false;
  if (!Number.isInteger(msg.windowId)) {
    sendResponse({ error: "invalid windowId" });
    return false;
  }
  handleMessage(msg).then(sendResponse, (e) => sendResponse({ error: sanitizeText(e.message, 300) }));
  return true;
});
