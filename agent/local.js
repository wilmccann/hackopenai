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

// ---------------------------------------------------------------------------
// F30 to F33. Category grouping and ordering.
// ---------------------------------------------------------------------------
// Fixed category list, in tab-strip order. "Other" is implicit: a tab that fits
// no category stays ungrouped (F31, F33).
export const CATEGORIES = Object.freeze(["Video", "Sports", "News", "Retail", "Business"]);
export const MAX_GROUPS = 12;

// Local domain-to-category map for the no-model fallback (F33) and for tabs
// the model leaves unassigned. Matched against the registrable domain and, for
// the keyword entries, against the full host (news.google.com, sports.yahoo.com).
const CATEGORY_DOMAINS = {
  Video: ["youtube.com", "youtu.be", "netflix.com", "hulu.com", "vimeo.com", "twitch.tv", "disneyplus.com", "primevideo.com", "max.com", "hbomax.com", "peacocktv.com", "paramountplus.com", "tiktok.com", "dailymotion.com", "plex.tv", "crunchyroll.com", "tubitv.com", "roku.com", "appletv.com"],
  Sports: ["espn.com", "nba.com", "nfl.com", "mlb.com", "nhl.com", "fifa.com", "uefa.com", "mlssoccer.com", "pgatour.com", "olympics.com", "skysports.com", "bleacherreport.com", "cbssports.com", "foxsports.com", "theathletic.com", "nbcsports.com", "si.com", "sports.yahoo.com", "goal.com", "atptour.com", "wtatennis.com", "formula1.com", "nascar.com", "ufc.com", "wwe.com"],
  News: ["nytimes.com", "news.google.com", "washingtonpost.com", "wsj.com", "bbc.com", "bbc.co.uk", "cnn.com", "reuters.com", "apnews.com", "theguardian.com", "foxnews.com", "nbcnews.com", "cbsnews.com", "abcnews.go.com", "npr.org", "latimes.com", "usatoday.com", "politico.com", "axios.com", "news.yahoo.com", "msnbc.com", "aljazeera.com", "time.com", "theatlantic.com", "newsweek.com", "huffpost.com", "vox.com", "thehill.com", "bostonglobe.com", "chicagotribune.com", "sfchronicle.com"],
  Retail: ["amazon.com", "bestbuy.com", "staples.com", "sears.com", "macys.com", "target.com", "walmart.com", "homedepot.com", "lowes.com", "costco.com", "ebay.com", "etsy.com", "wayfair.com", "ikea.com", "nordstrom.com", "kohls.com", "nike.com", "adidas.com", "zappos.com", "shein.com", "temu.com", "aliexpress.com", "newegg.com", "officedepot.com", "jcpenney.com", "gap.com", "oldnavy.com", "bhphotovideo.com", "chewy.com", "overstock.com", "samsclub.com", "cvs.com", "walgreens.com"],
  Business: ["boeing.com", "linkedin.com", "bloomberg.com", "forbes.com", "cnbc.com", "ft.com", "marketwatch.com", "fortune.com", "businessinsider.com", "economist.com", "hbr.org", "crunchbase.com", "sec.gov", "glassdoor.com", "indeed.com", "salesforce.com", "investopedia.com", "morningstar.com", "fool.com", "barrons.com", "inc.com", "entrepreneur.com", "fastcompany.com", "techcrunch.com"]
};
const CATEGORY_HOST_KEYWORDS = { Sports: ["sports"], News: ["news"], Retail: ["shop", "store"], Video: ["video", "tv"] };
const DOMAIN_TO_CATEGORY = new Map();
for (const [cat, list] of Object.entries(CATEGORY_DOMAINS)) for (const d of list) DOMAIN_TO_CATEGORY.set(d, cat);

// Returns one of CATEGORIES or "" (Other). Pure host lookup, no page content.
export function categoryOf(tab) {
  const host = hostOf(tab?.url);
  if (!host) return "";
  const domain = registrableDomain(host);
  if (DOMAIN_TO_CATEGORY.has(host)) return DOMAIN_TO_CATEGORY.get(host);
  if (DOMAIN_TO_CATEGORY.has(domain)) return DOMAIN_TO_CATEGORY.get(domain);
  // Subdomain keywords: sports.yahoo.com, news.ycombinator.com, shop.example.com.
  const labels = host.split(".");
  for (const [cat, words] of Object.entries(CATEGORY_HOST_KEYWORDS)) {
    if (labels.some((l) => words.includes(l))) return cat;
  }
  return "";
}

export const categoryKey = (cat) => `category:${cat.toLowerCase()}`;
const categoryColor = (cat) => COLORS[CATEGORIES.indexOf(cat) % COLORS.length];

function groupableByCategory(tabs) {
  const byCat = new Map(CATEGORIES.map((c) => [c, []]));
  for (const t of tabs) {
    if (t.pinned) continue;
    const c = categoryOf(t);
    if (c) byCat.get(c).push(t);
  }
  return [...byCat.entries()].filter(([, list]) => list.length >= 2);
}

// F33. Fallback plan (no model): one group per category with 2 or more tabs,
// in CATEGORIES order. Tabs that fit no category (Other) stay ungrouped.
export function categoryFallbackPlan(tabs, { duplicates = [], stale = [] } = {}) {
  const groups = [];
  const assignments = [];
  for (const [cat, list] of groupableByCategory(tabs)) {
    const key = categoryKey(cat);
    groups.push({ key, title: cat, color: categoryColor(cat) });
    for (const t of list) assignments.push({ tab_id: t.id, group_key: key });
  }
  const summary = groups.length
    ? `Grouped ${assignments.length} tabs into ${groups.length} categories.`
    : "No category has more than one tab to group.";
  return orderPlan({ summary, groups, assignments, duplicates, stale }, tabs);
}

// Tabs the model left unassigned join the plan's group for their local
// category when that group exists, or form a new one when at least two of
// them share a category. Other stays ungrouped (decision 3).
export function mergeUnassignedByCategory(plan, tabs) {
  const assigned = new Set(plan.assignments.map((a) => a.tab_id));
  const leftover = tabs.filter((t) => !assigned.has(t.id) && !t.pinned);
  const groups = [...plan.groups];
  const assignments = [...plan.assignments];
  const byTitle = new Map(groups.map((g) => [g.title.toLowerCase(), g]));
  const pending = new Map();
  for (const t of leftover) {
    const c = categoryOf(t);
    if (!c) continue;
    const g = byTitle.get(c.toLowerCase());
    if (g) assignments.push({ tab_id: t.id, group_key: g.key });
    else pending.set(c, [...(pending.get(c) || []), t]);
  }
  for (const [c, list] of pending) {
    if (list.length < 2) continue;
    let key = categoryKey(c);
    while (groups.some((g) => g.key === key)) key += "_";
    groups.push({ key, title: c, color: categoryColor(c) });
    for (const t of list) assignments.push({ tab_id: t.id, group_key: key });
  }
  return { ...plan, groups, assignments };
}

// F31 (and F20): a group exists only for two or more tabs. The model is told
// this but does not always comply; singletons go back to ungrouped here.
export function dropSingletonGroups(plan) {
  const count = new Map();
  for (const a of plan.assignments) count.set(a.group_key, (count.get(a.group_key) || 0) + 1);
  const keep = new Set(plan.groups.filter((g) => (count.get(g.key) || 0) >= 2).map((g) => g.key));
  if (keep.size === plan.groups.length) return plan;
  return { ...plan, groups: plan.groups.filter((g) => keep.has(g.key)), assignments: plan.assignments.filter((a) => keep.has(a.group_key)) };
}

// F32. Order groups by category (CATEGORIES order first, other titles after,
// alphabetically), and tabs within a group by website: registrable domain,
// then full host, then original tab position. Returns a new plan whose
// groups and assignments are in the order they should appear in the strip.
export function orderPlan(plan, tabs) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const rank = (g) => {
    const i = CATEGORIES.findIndex((c) => c.toLowerCase() === String(g.title).toLowerCase());
    return i === -1 ? CATEGORIES.length : i;
  };
  const groups = [...plan.groups].sort((a, b) => rank(a) - rank(b) || String(a.title).localeCompare(String(b.title)));
  const siteKey = (id) => {
    const t = byId.get(id);
    const host = hostOf(t?.url);
    return [registrableDomain(host) || host || "~", host || "~", t?.index ?? 0];
  };
  const cmp = (x, y) => {
    const [dx, hx, ix] = siteKey(x.tab_id);
    const [dy, hy, iy] = siteKey(y.tab_id);
    return dx.localeCompare(dy) || hx.localeCompare(hy) || ix - iy;
  };
  const assignments = [];
  for (const g of groups) assignments.push(...plan.assignments.filter((a) => a.group_key === g.key).sort(cmp));
  for (const a of plan.assignments) if (!groups.some((g) => g.key === a.group_key)) assignments.push(a);
  return { ...plan, groups, assignments };
}
