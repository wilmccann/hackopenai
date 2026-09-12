import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, registrableDomain, findDuplicates, findStale, domainFallbackPlan, mergeUnassignedByDomain } from "../agent/local.js";
import { validatePlan, sanitizePlan, buildUserMessage } from "../agent/plan.js";

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
  assert.deepEqual(validatePlan(plan, tabs), []);
});

test("mergeUnassignedByDomain appends domain groups for leftovers only", () => {
  const tabs = [tab(1, "https://a.com/1"), tab(2, "https://a.com/2"), tab(3, "https://b.com/1"), tab(4, "https://b.com/2")];
  const plan = { summary: "s", groups: [{ key: "work", title: "Work", color: "blue" }], assignments: [{ tab_id: 1, group_key: "work" }, { tab_id: 2, group_key: "work" }], duplicates: [], stale: [] };
  const merged = mergeUnassignedByDomain(plan, tabs);
  assert.equal(merged.groups.length, 2);
  assert.equal(merged.groups[1].title, "b.com");
  assert.notEqual(merged.groups[1].color, "blue");
  assert.deepEqual(validatePlan(merged, tabs), []);
});

test("validatePlan catches unknown ids, pinned, double assignment, bad color", () => {
  const tabs = [tab(1, "https://a.com"), tab(2, "https://b.com", { pinned: true })];
  const plan = { summary: "s", groups: [{ key: "g", title: "G", color: "magenta" }], assignments: [{ tab_id: 1, group_key: "g" }, { tab_id: 1, group_key: "g" }, { tab_id: 2, group_key: "g" }, { tab_id: 99, group_key: "nope" }], duplicates: [{ tab_id: 1, keep_tab_id: 1, reason: "" }], stale: [{ tab_id: 42, reason: "" }] };
  const errors = validatePlan(plan, tabs);
  assert.ok(errors.some((e) => e.includes("invalid color")));
  assert.ok(errors.some((e) => e.includes("assigned twice")));
  assert.ok(errors.some((e) => e.includes("pinned tab 2")));
  assert.ok(errors.some((e) => e.includes("unknown tab_id 99")));
  assert.ok(errors.some((e) => e.includes("unknown group_key nope")));
  assert.ok(errors.some((e) => e.includes("keeps itself")));
  assert.ok(errors.some((e) => e.includes("unknown tab_id 42")));
  const fixed = sanitizePlan(plan, tabs);
  assert.deepEqual(validatePlan(fixed, tabs), []);
  assert.equal(fixed.assignments.length, 1);
});

test("buildUserMessage carries basis, candidates, and excerpt", () => {
  const tabs = [tab(1, "https://a.com", { excerpt: "hello" })];
  const msg = buildUserMessage(tabs, { groupingBasis: "website" }, { duplicates: [{ tab_id: 1, keep_tab_id: 2, reason: "" }] }, now);
  assert.equal(msg.grouping_basis, "website");
  assert.equal(msg.tabs[0].excerpt, "hello");
  assert.equal(msg.duplicate_candidates.length, 1);
  assert.equal(msg.max_groups, 6);
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

test("resolveProvider picks the per-provider key with legacy fallback", async () => {
  const { resolveProvider } = await import("../agent/providers.js");
  assert.equal(resolveProvider({ provider: "nvidia", apiKeys: { nvidia: "nv", openai: "oa" } }).apiKey, "nv");
  assert.equal(resolveProvider({ provider: "openai", apiKeys: { nvidia: "nv" }, apiKey: "legacy" }).apiKey, "legacy");
  assert.equal(resolveProvider({ provider: "anthropic" }).apiKey, "");
});
