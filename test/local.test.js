import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, registrableDomain, findDuplicates, findStale, domainFallbackPlan, mergeUnassignedByDomain, fingerprintTabs, remapPlan, CATEGORIES, categoryOf, categoryFallbackPlan, mergeUnassignedByCategory, orderPlan, dropSingletonGroups } from "../agent/local.js";
import { validatePlan, sanitizePlan, buildUserMessage, sanitizeText, urlForModel, SYSTEM_PROMPT, LIMITS } from "../agent/plan.js";

const H = 3600 * 1000;
const now = Date.now();
const tab = (id, url, extra = {}) => ({ id, index: id, title: `Tab ${id}`, url, pinned: false, audible: false, discarded: false, lastAccessed: now, groupId: -1, ...extra });

test("normalizeUrl strips tracking, fragment, case, trailing slash", () => {
  assert.equal(normalizeUrl("https://React.dev/reference/react/useEffect/?utm_source=x&fbclid=1#top"), "https://react.dev/reference/react/useEffect");
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com");
  assert.equal(normalizeUrl("https://example.com/a?q=1&utm_medium=m"), "https://example.com/a?q=1");
  assert.equal(normalizeUrl("https://en.wikipedia.org/wiki/Lisbon#Climate"), normalizeUrl("https://en.wikipedia.org/wiki/Lisbon"));
});

test("registrableDomain handles www and two-level TLDs", () => {
  assert.equal(registrableDomain("www.docs.google.com"), "google.com");
  assert.equal(registrableDomain("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("localhost"), "localhost");
});

test("findDuplicates keeps the most recent, never closes pinned", () => {
  const tabs = [
    tab(1, "https://a.com/x", { lastAccessed: now - H }),
    tab(2, "https://a.com/x?utm_source=s", { lastAccessed: now }),
    tab(3, "https://a.com/x#frag", { pinned: true, lastAccessed: now - 5 * H }),
    tab(4, "https://b.com")
  ];
  const d = findDuplicates(tabs);
  assert.deepEqual(d.map((x) => [x.tab_id, x.keep_tab_id]).sort(), [[1, 3], [2, 3]]);
});

test("findStale uses age or discarded, skips pinned/audible/grouped", () => {
  const tabs = [
    tab(1, "https://a.com", { lastAccessed: now - 30 * H }),
    tab(2, "https://b.com", { discarded: true }),
    tab(3, "https://c.com", { lastAccessed: now - 30 * H, pinned: true }),
    tab(4, "https://d.com", { lastAccessed: now - 30 * H, audible: true }),
    tab(5, "https://e.com", { lastAccessed: now - 30 * H, groupId: 7 }),
    tab(6, "https://f.com")
  ];
  assert.deepEqual(findStale(tabs, 24, now).map((s) => s.tab_id), [1, 2]);
});

test("domainFallbackPlan groups domains with 2+ tabs and leaves singletons", () => {
  const tabs = [tab(1, "https://a.com/1"), tab(2, "https://www.a.com/2"), tab(3, "https://b.com"), tab(4, "https://c.com/1"), tab(5, "https://c.com/2"), tab(6, "https://d.com", { pinned: true })];
  const plan = domainFallbackPlan(tabs);
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.assignments.length, 4);
  assert.notEqual(plan.groups[0].color, plan.groups[1].color);
  assert.deepEqual(validatePlan(plan, tabs, { basis: "website" }), []);
});

test("mergeUnassignedByDomain appends domain groups for leftovers only", () => {
  const tabs = [tab(1, "https://a.com/1"), tab(2, "https://a.com/2"), tab(3, "https://b.com/1"), tab(4, "https://b.com/2")];
  const plan = { summary: "s", groups: [{ key: "work", title: "Work", color: "blue" }], assignments: [{ tab_id: 1, group_key: "work" }, { tab_id: 2, group_key: "work" }], duplicates: [], stale: [] };
  const merged = mergeUnassignedByDomain(plan, tabs);
  assert.equal(merged.groups.length, 2);
  assert.equal(merged.groups[1].title, "b.com");
  assert.notEqual(merged.groups[1].color, "blue");
  assert.deepEqual(validatePlan(merged, tabs, { basis: "website" }), []);
});

test("validatePlan catches unknown ids, pinned, double assignment, bad color", () => {
  const tabs = [tab(1, "https://a.com"), tab(2, "https://b.com", { pinned: true })];
  const plan = { summary: "s", groups: [{ key: "g", title: "G", color: "magenta" }], assignments: [{ tab_id: 1, group_key: "g" }, { tab_id: 1, group_key: "g" }, { tab_id: 2, group_key: "g" }, { tab_id: 99, group_key: "nope" }], duplicates: [{ tab_id: 1, keep_tab_id: 1, reason: "" }], stale: [{ tab_id: 42, reason: "" }] };
  const errors = validatePlan(plan, tabs, { basis: "website" });
  assert.ok(errors.some((e) => e.includes("invalid color")));
  assert.ok(errors.some((e) => e.includes("assigned twice")));
  assert.ok(errors.some((e) => e.includes("pinned tab 2")));
  assert.ok(errors.some((e) => e.includes("unknown tab_id 99")));
  assert.ok(errors.some((e) => e.includes("unknown group_key nope")));
  assert.ok(errors.some((e) => e.includes("keeps itself")));
  assert.ok(errors.some((e) => e.includes("unknown tab_id 42")));
  const fixed = sanitizePlan(plan, tabs, { basis: "website" });
  assert.deepEqual(validatePlan(fixed, tabs, { basis: "website" }), []);
  assert.equal(fixed.assignments.length, 1);
});

test("buildUserMessage carries basis, candidates, and excerpt", () => {
  const tabs = [tab(1, "https://a.com", { excerpt: "hello" })];
  const msg = buildUserMessage(tabs, { groupingBasis: "website" }, { duplicates: [{ tab_id: 1, keep_tab_id: 2, reason: "" }] }, now);
  assert.equal(msg.grouping_basis, "website");
  assert.equal(msg.tabs[0].excerpt, "hello");
  assert.equal(msg.duplicate_candidates.length, 1);
  assert.equal(msg.max_groups, 12);
  assert.deepEqual(msg.categories, [...CATEGORIES]);
  assert.equal(buildUserMessage(tabs, { groupingBasis: "task" }, {}, now).grouping_basis, "category");
});

// F30 to F33
test("categoryOf maps hosts by domain and subdomain keyword, Other is empty", () => {
  assert.equal(categoryOf({ url: "https://www.youtube.com/watch?v=x" }), "Video");
  assert.equal(categoryOf({ url: "https://news.google.com/" }), "News");
  assert.equal(categoryOf({ url: "https://sports.yahoo.com/nba" }), "Sports");
  assert.equal(categoryOf({ url: "https://www.boeing.com/" }), "Business");
  assert.equal(categoryOf({ url: "https://www.macys.com/" }), "Retail");
  assert.equal(categoryOf({ url: "https://mail.google.com/" }), "");
  assert.equal(categoryOf({ url: "chrome://newtab" }), "");
});

test("categoryFallbackPlan groups categories with 2+ tabs in fixed order, leaves Other and singletons ungrouped", () => {
  const tabs = [
    tab(1, "https://www.macys.com/"), tab(2, "https://www.nytimes.com/section/business"), tab(3, "https://mail.google.com/"),
    tab(4, "https://www.bestbuy.com/"), tab(5, "https://news.google.com/"), tab(6, "https://www.boeing.com/"), tab(7, "https://www.netflix.com/", { pinned: true })
  ];
  const plan = categoryFallbackPlan(tabs);
  assert.deepEqual(plan.groups.map((g) => g.title), ["News", "Retail"]);
  assert.equal(plan.assignments.length, 4);
  assert.deepEqual(validatePlan(plan, tabs), []);
  assert.deepEqual(validatePlan(plan, tabs, { basis: "website" }), []);
});

test("orderPlan sorts groups by category order and tabs within a group by website", () => {
  const tabs = [tab(1, "https://www.target.com/"), tab(2, "https://www.bestbuy.com/x"), tab(3, "https://www.bestbuy.com/a"), tab(4, "https://www.nytimes.com/"), tab(5, "https://www.espn.com/"), tab(6, "https://www.espn.com/nba")];
  const plan = { summary: "", duplicates: [], stale: [],
    groups: [{ key: "r", title: "Retail", color: "blue" }, { key: "n", title: "News", color: "red" }, { key: "s", title: "Sports", color: "green" }],
    assignments: [{ tab_id: 1, group_key: "r" }, { tab_id: 2, group_key: "r" }, { tab_id: 3, group_key: "r" }, { tab_id: 4, group_key: "n" }, { tab_id: 6, group_key: "s" }, { tab_id: 5, group_key: "s" }] };
  const out = orderPlan(plan, tabs);
  assert.deepEqual(out.groups.map((g) => g.title), ["Sports", "News", "Retail"]);
  assert.deepEqual(out.assignments.map((a) => a.tab_id), [5, 6, 4, 2, 3, 1]);
});

test("mergeUnassignedByCategory joins existing category groups, forms new ones for pairs, leaves Other alone", () => {
  const tabs = [tab(1, "https://www.nytimes.com/"), tab(2, "https://www.cnn.com/"), tab(3, "https://www.espn.com/"), tab(4, "https://www.nba.com/"), tab(5, "https://www.boeing.com/"), tab(6, "https://mail.google.com/")];
  const plan = { summary: "", duplicates: [], stale: [], groups: [{ key: "n", title: "News", color: "red" }], assignments: [{ tab_id: 1, group_key: "n" }] };
  const out = mergeUnassignedByCategory(plan, tabs);
  assert.deepEqual(out.groups.map((g) => g.title), ["News", "Sports"]);
  assert.equal(out.assignments.length, 4);
  assert.ok(!out.assignments.some((a) => a.tab_id === 5 || a.tab_id === 6));
  assert.deepEqual(validatePlan(out, tabs), []);
});

test("dropSingletonGroups ungroups one-tab groups and keeps the rest", () => {
  const plan = { summary: "", duplicates: [], stale: [], groups: [{ key: "n", title: "News", color: "red" }, { key: "b", title: "Business", color: "blue" }], assignments: [{ tab_id: 1, group_key: "n" }, { tab_id: 2, group_key: "n" }, { tab_id: 3, group_key: "b" }] };
  const out = dropSingletonGroups(plan);
  assert.deepEqual(out.groups.map((g) => g.title), ["News"]);
  assert.deepEqual(out.assignments.map((a) => a.tab_id), [1, 2]);
});

test("F31: category mode rejects titles outside the fixed list and repeated categories; website mode does not", () => {
  const tabs = [tab(1, "https://a.com"), tab(2, "https://b.com")];
  const mk = (titles) => ({ summary: "", duplicates: [], stale: [], groups: titles.map((t, i) => ({ key: `g${i}`, title: t, color: "blue" })), assignments: [] });
  assert.ok(validatePlan(mk(["Apartment Hunt"]), tabs).some((e) => e.includes("allowed categories")));
  assert.ok(validatePlan(mk(["News", "news"]), tabs).some((e) => e.includes("more than one group")));
  assert.deepEqual(validatePlan(mk(["news"]), tabs), []);
  assert.deepEqual(validatePlan(mk(["Apartment Hunt"]), tabs, { basis: "website" }), []);
  const fixed = sanitizePlan(mk(["Apartment Hunt", "news", "News", "Retail"]), tabs);
  assert.deepEqual(fixed.groups.map((g) => g.title), ["News", "Retail"]);
});

test("every provider lists its default model and resolveProvider ignores foreign ids", async () => {
  const { PROVIDERS, resolveProvider } = await import("../agent/providers.js");
  const { MODEL_CONFIG } = await import("../agent/config.js");
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const ids = p.models.map((m) => m.id);
    assert.ok(ids.length >= 1, `${name} has models`);
    assert.ok(ids.includes(p.defaults.model), `${name} default ${p.defaults.model} is in its list`);
    const override = MODEL_CONFIG.overrides[name]?.model;
    if (override) assert.ok(ids.includes(override), `${name} config override ${override} is in its list`);
  }
  assert.equal(resolveProvider({ provider: "nvidia", model: "gpt-6-astra" }).opts.model, "deepseek-ai/deepseek-v4-flash-0731");
  assert.equal(resolveProvider({ provider: "nvidia", model: "moonshotai/kimi-k3" }).opts.model, "moonshotai/kimi-k3");
  assert.equal(resolveProvider({ provider: "openai" }).opts.model, "gpt-5.6-terra");
});

test("resolveProvider picks the per-provider key and ignores the legacy settings.apiKey", async () => {
  const { resolveProvider } = await import("../agent/providers.js");
  assert.equal(resolveProvider({ provider: "nvidia", apiKeys: { nvidia: "nv", openai: "oa" } }).apiKey, "nv");
  // M2: a key minted for one vendor must never be sent to another host.
  assert.equal(resolveProvider({ provider: "openai", apiKeys: { nvidia: "nv" }, apiKey: "sk-ant-LEGACY" }).apiKey, "");
  assert.equal(resolveProvider({ provider: "openai", apiKey: "x" }).apiKey, "");
  assert.equal(resolveProvider({ provider: "nvidia", apiKeys: { anthropic: "sk-ant-REAL" }, apiKey: "sk-ant-LEGACY" }).apiKey, "");
  assert.equal(resolveProvider({ provider: "anthropic" }).apiKey, "");
});

// ---------------------------------------------------------------------------
// Security hardening (docs/SECURITY.md)
// ---------------------------------------------------------------------------
test("resolveProvider rejects unknown and prototype-inherited provider names", async () => {
  const { resolveProvider, isKnownProvider } = await import("../agent/providers.js");
  for (const bad of ["__proto__", "constructor", "toString", "hasOwnProperty", "evil", 42, null]) {
    assert.equal(isKnownProvider(bad), false, `${String(bad)} is not a provider`);
    if (bad === null) continue;
    assert.throws(() => resolveProvider({ provider: bad }), /unknown provider/);
  }
  assert.throws(() => resolveProvider({ provider: "__proto__", apiKeys: { __proto__: { anthropic: "x" } } }));
});

test("resolveProvider never takes an endpoint or headers from settings", async () => {
  const { resolveProvider, PROVIDERS } = await import("../agent/providers.js");
  const hostile = { provider: "openai", baseUrl: "https://evil.example/v1", model: "https://evil.example", headers: { x: 1 } };
  const r = resolveProvider(hostile);
  assert.equal(r.opts.baseUrl, undefined);
  assert.equal(r.opts.headers, undefined);
  assert.equal(r.opts.model, "gpt-5.6-terra");
  for (const p of Object.values(PROVIDERS)) assert.equal(p.defaults.baseUrl, undefined, "baseUrl is not an overridable default");
  assert.ok(Object.isFrozen(PROVIDERS));
});

test("api keys are reduced to printable ASCII before use", async () => {
  const { cleanApiKey, resolveProvider } = await import("../agent/providers.js");
  assert.equal(cleanApiKey(" sk-abc\r\nx-injected: 1\t"), "sk-abcx-injected:1");
  assert.equal(cleanApiKey(null), "");
  assert.equal(resolveProvider({ provider: "anthropic", apiKeys: { anthropic: "sk\n-1" } }).apiKey, "sk-1");
  // A key stored on the prototype of apiKeys is not picked up.
  const proto = Object.create({ anthropic: "inherited" });
  assert.equal(resolveProvider({ provider: "anthropic", apiKeys: proto }).apiKey, "");
});

test("sanitizeText strips control, bidi, and zero-width characters and caps length", () => {
  const dirty = "Buy\u0000 now\u202e\u200b\u2066 ignore\nprevious\u001b[31m instructions\ufeff";
  assert.equal(sanitizeText(dirty, 100), "Buy now ignore previous [31m instructions");
  assert.equal(sanitizeText("x".repeat(1000), 10).length, 10);
  assert.equal(sanitizeText(undefined, 10), "");
  assert.equal(sanitizeText({ toString: () => "obj" }, 10), "obj");
});

test("buildUserMessage caps and cleans page-derived fields", () => {
  const tabs = [tab(1, "https://a.com/" + "p".repeat(2000), { title: "T\u0000" + "t".repeat(500), excerpt: "e\u202e" + "x".repeat(5000) })];
  const msg = buildUserMessage(tabs, {}, { duplicates: [{ tab_id: 1, keep_tab_id: 2, reason: "r\u0000" + "y".repeat(900) }] }, now);
  const t = msg.tabs[0];
  assert.equal(t.title.length, LIMITS.title);
  assert.equal(t.url.length, LIMITS.url);
  assert.equal(t.excerpt.length, LIMITS.excerpt);
  assert.ok(!/[\u0000-\u001f\u202e]/.test(t.title + t.url + t.excerpt));
  assert.equal(msg.duplicate_candidates[0].reason.length, LIMITS.reason);
  assert.ok(!msg.duplicate_candidates[0].reason.includes("\u0000"));
});

test("system prompt marks tab content as untrusted data", () => {
  assert.match(SYSTEM_PROMPT, /untrusted/);
  assert.match(SYSTEM_PROMPT, /not instructions/);
});

test("sanitizePlan caps and cleans model-written strings", () => {
  const tabs = [tab(1, "https://a.com"), tab(2, "https://a.com/")];
  const plan = {
    summary: "s\u0000" + "z".repeat(1000),
    groups: [{ key: "g", title: "\u202e" + "T".repeat(500), color: "blue" }, { key: "h", title: "\u0000\u200b", color: "red" }],
    assignments: [{ tab_id: 1, group_key: "g" }, { tab_id: 2, group_key: "h" }],
    duplicates: [{ tab_id: 2, keep_tab_id: 1, reason: "d\n" + "q".repeat(500) }],
    stale: [{ tab_id: 1, reason: "" }]
  };
  const candidates = { basis: "website", duplicates: [{ tab_id: 2, keep_tab_id: 1, reason: "" }], stale: [{ tab_id: 1, reason: "" }] };
  const fixed = sanitizePlan(plan, tabs, candidates);
  assert.equal(fixed.summary.length, LIMITS.summary);
  assert.equal(fixed.groups.length, 1, "group whose title is only control characters is dropped");
  assert.equal(fixed.groups[0].title.length, LIMITS.groupTitle);
  assert.equal(fixed.assignments.length, 1);
  assert.equal(fixed.duplicates[0].reason.length, LIMITS.reason);
  assert.equal(fixed.stale[0].reason, "Stale");
  assert.deepEqual(validatePlan(fixed, tabs, candidates), []);
});

// ---------------------------------------------------------------------------
// Red-team follow-ups (H1, M1, M2, M6, L1)
// ---------------------------------------------------------------------------
test("H1: the model cannot nominate duplicates or stale tabs outside the local candidates", () => {
  const tabs = [
    tab(10, "https://evil.example/page"),
    tab(12, "https://bank.example/accounts"),
    tab(13, "https://mail.example/inbox"),
    tab(14, "https://docs.example/notes")
  ];
  const candidates = { duplicates: [], stale: [] };
  const plan = {
    summary: "s", groups: [], assignments: [],
    duplicates: [{ tab_id: 12, keep_tab_id: 10, reason: "Same page is already open" }, { tab_id: 13, keep_tab_id: 10, reason: "Same page is already open" }],
    stale: [{ tab_id: 14, reason: "Not opened in a while" }]
  };
  const errors = validatePlan(plan, tabs, candidates);
  assert.ok(errors.some((e) => e.includes("duplicate 12") && e.includes("not in duplicate_candidates")));
  assert.ok(errors.some((e) => e.includes("duplicate 13") && e.includes("not in duplicate_candidates")));
  assert.ok(errors.some((e) => e.includes("stale 14") && e.includes("not in stale_candidates")));
  const fixed = sanitizePlan(plan, tabs, candidates);
  assert.deepEqual(fixed.duplicates, []);
  assert.deepEqual(fixed.stale, []);
  // With no candidates argument at all, nothing may be closed either.
  assert.ok(validatePlan(plan, tabs).length >= 3);
  assert.deepEqual(sanitizePlan(plan, tabs).duplicates, []);
});

test("H1: only the exact (tab_id, keep_tab_id) pair from findDuplicates is accepted; keep-swap is rejected", () => {
  const tabs = [
    tab(1, "https://chase.com/login", { lastAccessed: now }),
    tab(2, "https://chase.com/login?utm_source=mail", { lastAccessed: now - H }),
    tab(3, "https://chase.com.evil.example/login", { lastAccessed: now }),
    tab(4, "https://docs.example/old", { lastAccessed: now - 48 * H })
  ];
  const candidates = { duplicates: findDuplicates(tabs), stale: findStale(tabs, 24, now) };
  assert.deepEqual(candidates.duplicates.map((d) => [d.tab_id, d.keep_tab_id]), [[2, 1]]);
  assert.deepEqual(candidates.stale.map((s) => s.tab_id), [4]);

  const ok = { summary: "s", groups: [], assignments: [], duplicates: [{ tab_id: 2, keep_tab_id: 1, reason: "dup" }], stale: [{ tab_id: 4, reason: "old" }] };
  assert.deepEqual(validatePlan(ok, tabs, candidates), []);
  assert.equal(sanitizePlan(ok, tabs, candidates).duplicates.length, 1);
  assert.equal(sanitizePlan(ok, tabs, candidates).stale.length, 1);

  // Swapped pair: close the real tab, keep the older copy. Not a candidate pair.
  const swapped = { ...ok, duplicates: [{ tab_id: 1, keep_tab_id: 2, reason: "dup" }] };
  assert.ok(validatePlan(swapped, tabs, candidates).some((e) => e.includes("not in duplicate_candidates")));
  assert.deepEqual(sanitizePlan(swapped, tabs, candidates).duplicates, []);

  // Phishing keep-swap: close the real chase.com tab and keep a look-alike host.
  const phish = { ...ok, duplicates: [{ tab_id: 1, keep_tab_id: 3, reason: "Same page is already open" }] };
  assert.ok(validatePlan(phish, tabs, candidates).length > 0);
  assert.deepEqual(sanitizePlan(phish, tabs, candidates).duplicates, []);

  // Even a candidate pair is dropped if the two tabs are on different registrable domains.
  const forged = { duplicates: [{ tab_id: 1, keep_tab_id: 3, reason: "" }], stale: [] };
  assert.ok(validatePlan(phish, tabs, forged).some((e) => e.includes("different sites")));
  assert.deepEqual(sanitizePlan(phish, tabs, forged).duplicates, []);
});

test("M1: query strings, fragments, and credentials never reach the model", () => {
  assert.equal(urlForModel("https://app.example/reset?token=SECRET&code=123#frag"), "https://app.example/reset");
  assert.equal(urlForModel("https://user:pw@app.example/a/b?x=1"), "https://app.example/a/b");
  assert.equal(urlForModel("chrome://settings/passwords"), "chrome:");
  assert.equal(urlForModel("not a url"), "");
  const msg = buildUserMessage([tab(1, "https://docs.example/d/abc?key=SHARED#gid=0")], {}, {}, now);
  assert.equal(msg.tabs[0].url, "https://docs.example/d/abc");
  assert.ok(!JSON.stringify(msg).includes("SHARED"));
});

test("M1: excerpt script reads meta description or <main> only, never document.body", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../content/excerpt.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/document\.body/.test(src), "no body fallback");
  assert.ok(/querySelector\("main"\)/.test(src));
  assert.ok(/slice\(0, 300\)/.test(src), "capped at 300");
  const bg = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
  assert.ok(/sendPageText === false\) return ""/.test(bg), "Settings toggle honored");
  assert.ok(/tab\.pinned \|\| \(tab\.groupId/.test(bg), "pinned and grouped tabs skipped");
});

test("M6: replay remaps a cached plan by URL fingerprint and refuses a poor match", () => {
  const before = [tab(1, "https://a.com/x"), tab(2, "https://a.com/x?utm_source=m"), tab(3, "https://b.com/y"), tab(4, "https://c.com/z")];
  const plan = {
    summary: "s", groups: [{ key: "g", title: "G", color: "blue" }],
    assignments: [{ tab_id: 1, group_key: "g" }, { tab_id: 3, group_key: "g" }, { tab_id: 4, group_key: "g" }],
    duplicates: [{ tab_id: 2, keep_tab_id: 1, reason: "dup" }],
    stale: [{ tab_id: 4, reason: "old" }]
  };
  const fps = fingerprintTabs(before);
  // Same pages, new session: Chrome handed out different ids, in a different order.
  const after = [tab(40, "https://c.com/z", { index: 0 }), tab(41, "https://a.com/x#top", { index: 1 }), tab(42, "https://a.com/x", { index: 2 }), tab(43, "https://b.com/y", { index: 3 }), tab(44, "https://unrelated.com", { index: 4 })];
  const r = remapPlan(plan, fps, after);
  assert.equal(r.total, 4);
  assert.equal(r.matched, 4);
  assert.deepEqual(r.plan.assignments.map((a) => a.tab_id).sort(), [40, 41, 43]);
  assert.deepEqual(r.plan.duplicates, [{ tab_id: 42, keep_tab_id: 41, reason: "dup" }]);
  assert.deepEqual(r.plan.stale, [{ tab_id: 40, reason: "old" }]);
  assert.deepEqual(validatePlan(r.plan, after, { basis: "website", duplicates: r.plan.duplicates, stale: r.plan.stale }), []);

  // Ids reused by unrelated tabs: nothing matches by fingerprint, so nothing is touched.
  const reused = [tab(1, "https://bank.example"), tab(2, "https://mail.example"), tab(3, "https://x.example"), tab(4, "https://y.example")];
  const bad = remapPlan(plan, fps, reused);
  assert.equal(bad.matched, 0);
  assert.deepEqual(bad.plan.assignments, []);
  assert.deepEqual(bad.plan.duplicates, []);
  assert.ok(bad.matched * 2 < bad.total, "background.js refuses replay below half");
  assert.deepEqual(remapPlan(plan, undefined, after).plan.assignments, []);
});

test("L1/M2: the panel never writes a stored key into the DOM and never reads settings.apiKey", async () => {
  const fs = await import("node:fs");
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const panel = read("sidepanel.js");
  assert.ok(!/apiKey\.value\s*=\s*(?!"")/.test(panel), "apiKey field is only ever set to an empty string");
  assert.ok(!/settings\.apiKey\b(?!\s*;)/.test(panel.replace(/delete settings\.apiKey;/g, "")), "no read of legacy settings.apiKey");
  assert.ok(!/\|\|\s*settings\.apiKey/.test(read("agent/providers.js")), "providers.js has no legacy key fallback");
  const bg = read("background.js");
  assert.ok(/assertNormalWindow/.test(bg) && /win\.incognito/.test(bg), "incognito guard present");
  assert.ok(/storage\.session\.set\(\{ closed:/.test(bg), "closed-tab list lives in storage.session");
  assert.ok(!/setLastRun\(\{[^}]*closed/.test(bg) && !/run\.closed/.test(bg), "closed-tab list is not part of lastRun in storage.local");
});

test("manifest has no externally_connectable and only fixed provider hosts", async () => {
  const fs = await import("node:fs");
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.externally_connectable, undefined);
  assert.ok(manifest.permissions.includes("favicon"));
  const { PROVIDERS } = await import("../agent/providers.js");
  for (const p of Object.values(PROVIDERS)) for (const h of p.hosts) assert.ok(manifest.host_permissions.includes(h), `${h} in host_permissions`);
});

test("sidepanel and content script never use HTML sinks; run-chrome has no debugging port", async () => {
  const fs = await import("node:fs");
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  for (const f of ["sidepanel.js", "content/excerpt.js", "background.js", "demo/open-demo.js"]) {
    const src = read(f);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(src), `${f} has no HTML/eval sinks`);
  }
  assert.ok(!/img\.src\s*=\s*row\./.test(read("sidepanel.js")) && !read("sidepanel.js").includes("row.favIconUrl"), "panel never loads page-supplied favicon URLs");
  assert.ok(!/--remote-debugging-port=|remote-debugging-port\s*[,\]]/.test(read("tools/run-chrome.py")), "no TCP debugging port");
  assert.ok(read("tools/run-chrome.py").includes("rmtree"), "scratch profile is deleted on exit");
});
