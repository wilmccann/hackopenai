// HackyTab Agent: opens demo/tabs.json into a fresh window (spec section 9, 11).
// Runs in the service worker. Triggered from the side panel's hidden dev
// section (Alt+Shift+D) or by calling openDemoWindow() in the worker console.
//
// The demo script wants the prompt to appear after the presenter opens two
// more tabs by hand, so `onWindowCreated` lets background.js pre-set the
// window's lastPromptedCount accordingly before the tabs pour in.

export async function loadDemoTabs() {
  const res = await fetch(chrome.runtime.getURL("demo/tabs.json"));
  const data = await res.json();
  return data.tabs;
}

export async function openDemoWindow({ onWindowCreated } = {}) {
  const tabs = await loadDemoTabs();
  const win = await chrome.windows.create({ url: tabs[0].url, focused: true });
  const windowId = win.id;
  if (onWindowCreated) await onWindowCreated(windowId, tabs.length);

  const staleIds = [];
  for (const t of tabs.slice(1)) {
    const tab = await chrome.tabs.create({ windowId, url: t.url, active: false });
    if (t.stale) staleIds.push(tab.id);
  }

  // Discarded tabs count as stale (F12). Give them a moment to get a title first.
  setTimeout(() => {
    for (const id of staleIds) chrome.tabs.discard(id).catch(() => {});
  }, 5000);

  return { windowId, count: tabs.length };
}
