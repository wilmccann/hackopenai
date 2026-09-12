// HackyTab Agent: local, deterministic tab logic (spec F11, F12, F20, section 6).
// Pure functions. No chrome.* calls, so this file is unit-testable in Node.

export const COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];
export const GROUP_NONE = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

const STRIP_EXACT = new Set(["fbclid", "gclid", "ref"]);
const STRIP_PREFIX = ["utm_", "mc_"];

// F11. Lowercase host, strip fragment, tracking params, trailing slash.
export function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return String(raw || "").trim().toLowerCase();
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (STRIP_EXACT.has(k) || STRIP_PREFIX.some((p) => k.startsWith(p))) u.searchParams.delete(key);
  }
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  let s = u.toString();
  if (s.endsWith("?")) s = s.slice(0, -1);
  if (u.pathname === "/" && !u.search && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);

// "www.docs.google.com" -> "google.com", "bbc.co.uk" -> "bbc.co.uk"
export function registrableDomain(hostname) {
  const h = (hostname || "").toLowerCase().replace(/^www\./, "");
  const parts = h.split(".").filter(Boolean);
  if (parts.length <= 2) return h;
  const [tld, second] = [parts[parts.length - 1], parts[parts.length - 2]];
  if (tld.length === 2 && SECOND_LEVEL.has(second)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

// F11. Every tab beyond the first per normalized URL is a duplicate candidate.
// Survivor: a pinned tab if any, else the most recently accessed.
export function findDuplicates(tabs) {
  const buckets = new Map();
  for (const t of tabs) {
    if (!t.url) continue;
    const key = normalizeUrl(t.url);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  const out = [];
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    });
    const keep = sorted[0];
    for (const t of sorted.slice(1)) {
      if (t.pinned) continue;
      out.push({ tab_id: t.id, keep_tab_id: keep.id, reason: "Same page is already open" });
    }
  }
  return out;
}

// F12. Older than staleHours (or already discarded by Chrome), not pinned,
// not audible, not already in a group.
export function findStale(tabs, staleHours = 24, now = Date.now()) {
  const cutoff = now - staleHours * 3600 * 1000;
  const out = [];
  for (const t of tabs) {
    if (t.pinned || t.audible) continue;
    if (t.groupId != null && t.groupId !== GROUP_NONE) continue;
    const old = typeof t.lastAccessed === "number" && t.lastAccessed < cutoff;
    if (!old && !t.discarded) continue;
    const reason = old
      ? `Not opened in ${Math.max(1, Math.round((now - t.lastAccessed) / 3600000))} hours`
      : "Chrome already put this tab to sleep";
    out.push({ tab_id: t.id, reason });
  }
  return out;
}

function groupableByDomain(tabs) {
  const byDomain = new Map();
  for (const t of tabs) {
    if (t.pinned || !t.url || !/^https?:/i.test(t.url)) continue;
    const d = registrableDomain(hostOf(t.url));
    if (!d) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(t);
  }
  return [...byDomain.entries()].filter(([, list]) => list.length >= 2);
}

// F20. One group per registrable domain with 2 or more tabs. Singletons ungrouped.
export function domainFallbackPlan(tabs, { duplicates = [], stale = [], usedColors = [] } = {}) {
  const palette = [...COLORS.filter((c) => !usedColors.includes(c)), ...COLORS];
  const groups = [];
  const assignments = [];
  groupableByDomain(tabs).forEach(([domain, list], i) => {
    const key = `domain:${domain}`;
    groups.push({ key, title: domain, color: palette[i % palette.length] });
    for (const t of list) assignments.push({ tab_id: t.id, group_key: key });
  });
  const summary = groups.length
    ? `Grouped ${assignments.length} tabs by site into ${groups.length} groups.`
    : "No sites with more than one tab to group.";
  return { summary, groups, assignments, duplicates, stale };
}

// Section 6, option C. Any tab the model left unassigned gets domain grouping.
export function mergeUnassignedByDomain(plan, tabs) {
  const assigned = new Set(plan.assignments.map((a) => a.tab_id));
  const leftover = tabs.filter((t) => !assigned.has(t.id));
  const extra = domainFallbackPlan(leftover, { usedColors: plan.groups.map((g) => g.color) });
  if (extra.groups.length === 0) return plan;
  const existingKeys = new Set(plan.groups.map((g) => g.key));
  const groups = [...plan.groups];
  const assignments = [...plan.assignments];
  for (const g of extra.groups) {
    let key = g.key;
    while (existingKeys.has(key)) key += "_";
    existingKeys.add(key);
    groups.push({ ...g, key });
    for (const a of extra.assignments) if (a.group_key === g.key) assignments.push({ tab_id: a.tab_id, group_key: key });
  }
  return { ...plan, groups, assignments };
}

// N3 replay. Chrome reuses numeric tab ids across sessions, so a cached plan is
// keyed by URL fingerprint (normalizeUrl) instead. `fingerprints` is
// { [oldTabId]: fingerprint } saved with the plan; `tabs` are the window's
// current tabs. Returns the plan rewritten with current ids, dropping every
// entry whose tab no longer exists, plus how many of the plan's tabs matched.
export function fingerprintTabs(tabs) {
  const out = {};
  for (const t of tabs) if (t.url) out[t.id] = normalizeUrl(t.url);
  return out;
}

export function remapPlan(plan, fingerprints, tabs) {
  const byFp = new Map();
  for (const t of [...tabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
    if (!t.url) continue;
    const fp = normalizeUrl(t.url);
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(t.id);
  }
  const referenced = new Set();
  for (const a of plan.assignments || []) referenced.add(a.tab_id);
  for (const d of plan.duplicates || []) referenced.add(d.tab_id), referenced.add(d.keep_tab_id);
  for (const s of plan.stale || []) referenced.add(s.tab_id);
  const idMap = new Map();
  for (const oldId of [...referenced].sort((a, b) => a - b)) {
    const list = byFp.get((fingerprints || {})[oldId]);
    if (list && list.length) idMap.set(oldId, list.shift());
  }
  const m = (id) => idMap.get(id);
  const remapped = {
    ...plan,
    assignments: (plan.assignments || []).filter((a) => idMap.has(a.tab_id)).map((a) => ({ ...a, tab_id: m(a.tab_id) })),
    duplicates: (plan.duplicates || [])
      .filter((d) => idMap.has(d.tab_id) && idMap.has(d.keep_tab_id))
      .map((d) => ({ ...d, tab_id: m(d.tab_id), keep_tab_id: m(d.keep_tab_id) })),
    stale: (plan.stale || []).filter((s) => idMap.has(s.tab_id)).map((s) => ({ ...s, tab_id: m(s.tab_id) }))
  };
  return { plan: remapped, matched: idMap.size, total: referenced.size };
}
