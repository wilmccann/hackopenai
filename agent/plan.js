// HackyTab Agent: planTabs() (spec F13, F14, section 7, section 8).
// Builds the prompt, calls the active provider, parses and validates the plan.
// Throws when no usable plan can be produced; the caller falls back to F20.

import { resolveProvider } from "./providers.js";
import { COLORS } from "./local.js";

export const SYSTEM_PROMPT = `You organize a person's open browser tabs into a small number of groups based on what they are trying to accomplish, not which website a tab is on. Prefer 3 to 6 groups. Group names are 1 to 3 words, specific, in title case. Assign each tab to exactly one group or leave it unassigned if it fits nowhere. Pick a distinct color per group from the allowed list. Confirm or reject each duplicate and stale candidate; reject a stale candidate if it looks like reference material the person will want again. Never assign a pinned tab. Only use tab ids that appear in the input. If grouping_basis is "website", group by site instead of task. Return only the JSON.`;

let schemaPromise = null;
export function loadSchema() {
  if (!schemaPromise) {
    schemaPromise = fetch(chrome.runtime.getURL("agent/schema.json")).then((r) => r.json());
  }
  return schemaPromise;
}

function tabForModel(t, now) {
  return {
    id: t.id,
    index: t.index,
    title: (t.title || "").slice(0, 200),
    url: (t.url || "").slice(0, 500),
    pinned: !!t.pinned,
    audible: !!t.audible,
    in_group: t.groupId != null && t.groupId !== -1,
    hours_since_access: typeof t.lastAccessed === "number" ? Math.round((now - t.lastAccessed) / 360000) / 10 : null,
    excerpt: t.excerpt || ""
  };
}

export function buildUserMessage(tabs, settings, { duplicates = [], stale = [] } = {}, now = Date.now()) {
  return {
    tabs: tabs.map((t) => tabForModel(t, now)),
    duplicate_candidates: duplicates,
    stale_candidates: stale,
    grouping_basis: settings.groupingBasis === "website" ? "website" : "task",
    max_groups: 6,
    allowed_colors: COLORS
  };
}

// Section 8 local validation. Returns a list of human-readable errors (empty = valid).
export function validatePlan(plan, tabs) {
  const errors = [];
  if (!plan || typeof plan !== "object") return ["plan is not an object"];
  for (const k of ["groups", "assignments", "duplicates", "stale"]) {
    if (!Array.isArray(plan[k])) errors.push(`${k} must be an array`);
  }
  if (typeof plan.summary !== "string") errors.push("summary must be a string");
  if (errors.length) return errors;

  const byId = new Map(tabs.map((t) => [t.id, t]));
  const keys = new Set();
  for (const g of plan.groups) {
    if (!g || typeof g.key !== "string" || !g.key) errors.push("group without key");
    else if (keys.has(g.key)) errors.push(`duplicate group key ${g.key}`);
    else keys.add(g.key);
    if (!g || typeof g.title !== "string" || !g.title.trim()) errors.push(`group ${g?.key} has no title`);
    if (!g || !COLORS.includes(g.color)) errors.push(`group ${g?.key} has invalid color ${g?.color}`);
  }
  if (plan.groups.length > 8) errors.push("more than 8 groups");

  const seen = new Set();
  for (const a of plan.assignments) {
    if (!byId.has(a?.tab_id)) errors.push(`assignment references unknown tab_id ${a?.tab_id}`);
    else if (byId.get(a.tab_id).pinned) errors.push(`pinned tab ${a.tab_id} must not be assigned`);
    if (!keys.has(a?.group_key)) errors.push(`assignment references unknown group_key ${a?.group_key}`);
    if (seen.has(a?.tab_id)) errors.push(`tab ${a.tab_id} assigned twice`);
    seen.add(a?.tab_id);
  }
  for (const d of plan.duplicates) {
    if (!byId.has(d?.tab_id)) errors.push(`duplicate references unknown tab_id ${d?.tab_id}`);
    if (!byId.has(d?.keep_tab_id)) errors.push(`duplicate references unknown keep_tab_id ${d?.keep_tab_id}`);
    if (d?.tab_id === d?.keep_tab_id) errors.push(`duplicate ${d?.tab_id} keeps itself`);
    if (byId.get(d?.tab_id)?.pinned) errors.push(`pinned tab ${d.tab_id} must not be closed`);
  }
  for (const s of plan.stale) {
    if (!byId.has(s?.tab_id)) errors.push(`stale references unknown tab_id ${s?.tab_id}`);
    if (byId.get(s?.tab_id)?.pinned) errors.push(`pinned tab ${s.tab_id} must not be closed`);
  }
  return errors;
}

// Drop invalid entries instead of rejecting the whole plan. Used only after
// the retry has also failed, so a mostly-right plan beats the domain fallback.
export function sanitizePlan(plan, tabs) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const groups = (plan.groups || [])
    .filter((g) => g && typeof g.key === "string" && g.key && typeof g.title === "string" && g.title.trim())
    .map((g, i) => ({ key: g.key, title: g.title.trim(), color: COLORS.includes(g.color) ? g.color : COLORS[i % COLORS.length] }))
    .filter((g, i, arr) => arr.findIndex((x) => x.key === g.key) === i)
    .slice(0, 8);
  const keys = new Set(groups.map((g) => g.key));
  const seen = new Set();
  const assignments = (plan.assignments || []).filter((a) => {
    const ok = a && byId.has(a.tab_id) && !byId.get(a.tab_id).pinned && keys.has(a.group_key) && !seen.has(a.tab_id);
    if (ok) seen.add(a.tab_id);
    return ok;
  });
  const duplicates = (plan.duplicates || []).filter(
    (d) => d && byId.has(d.tab_id) && byId.has(d.keep_tab_id) && d.tab_id !== d.keep_tab_id && !byId.get(d.tab_id).pinned
  ).map((d) => ({ tab_id: d.tab_id, keep_tab_id: d.keep_tab_id, reason: String(d.reason || "Duplicate") }));
  const stale = (plan.stale || []).filter((s) => s && byId.has(s.tab_id) && !byId.get(s.tab_id).pinned)
    .map((s) => ({ tab_id: s.tab_id, reason: String(s.reason || "Stale") }));
  return { summary: String(plan.summary || "Organized your tabs."), groups, assignments, duplicates, stale };
}

// F13, F14. One request, one retry with the validation error appended, then throw.
export async function planTabs(tabs, settings, candidates = {}) {
  if (!settings.apiKey) throw new Error("No API key set. Open Settings in the side panel.");
  const schema = await loadSchema();
  const { name, provider, opts, timeoutMs } = resolveProvider(settings);
  const base = buildUserMessage(tabs, settings, candidates);
  const started = Date.now();
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && Date.now() - started > timeoutMs) break;
    const user = attempt === 0 ? base : { ...base, previous_attempt_error: lastError };
    const text = await provider.call({ system: SYSTEM_PROMPT, user, schema, settings, opts, timeoutMs });
    let plan;
    try {
      plan = JSON.parse(text);
    } catch (e) {
      lastError = `Response was not valid JSON: ${e.message}`;
      continue;
    }
    const errors = validatePlan(plan, tabs);
    if (errors.length === 0) return plan;
    lastError = errors.slice(0, 10).join("; ");
    if (attempt === 1) {
      const fixed = sanitizePlan(plan, tabs);
      if (fixed.groups.length && fixed.assignments.length) return fixed;
    }
  }
  throw new Error(`${name}: plan validation failed: ${lastError}`);
}
