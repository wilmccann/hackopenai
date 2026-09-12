# HackyTab Agent: Specification

Version 0.1, Sep 12 2026, 12:55 pm. For team review. Companion to PROJECT.md.
Anything marked **OPEN** needs a decision. Everything else is the plan of record.

---

## 1. Summary

HackyTab Agent is a Chrome extension (Manifest V3). It watches tab counts per window. When a window crosses a user-configurable threshold (default 15), it opens the Chrome side panel and offers to organize that window. On approval it sends the window's tabs to Claude Fable 5.1, receives a structured plan, and applies it: named and colored tab groups, a duplicate list, and a stale list. Duplicates and stale tabs are shown as a checklist and are only closed after the user confirms. One click undoes the last run.

## 2. Goals and non-goals

**Goals**
- Proactive: the agent starts the conversation, not the user.
- Contextual: groups reflect what the user is doing, not just which site a tab is on.
- Safe: no tab is closed without explicit per-tab confirmation. Undo always available.
- Fast: prompt to organized tab strip in under 8 seconds on a 25-tab window.
- Demo-able live in under two minutes with an offline fallback.

**Non-goals (today)**
- Moving tabs between windows. (Stretch, section 12.)
- Natural language tab search.
- Persisting or syncing groups across restarts or devices.
- Any browser other than Chrome. Any backend server. Any user accounts.
- Reading full page content. Only title, URL, and a short excerpt.

## 3. Definitions

| Term | Meaning |
|---|---|
| Window | A Chrome window, identified by `windowId`. |
| Threshold | Tab count at which the agent offers to help. Default 15. |
| Plan | The JSON object the model returns describing groups, assignments, duplicates, stale tabs. |
| Run | One organize cycle: prompt, plan, apply, review. |
| Snapshot | The pre-run state of every tab's group in the window, used for undo. |
| Stale | A tab not accessed in 24 hours or more, not pinned, not audible, that the model also judges low value. |
| Duplicate | Two or more tabs whose normalized URL is identical. |

## 4. User stories

1. As a user with 22 tabs open, I am asked once whether I want help, and I can say Yes, Not now, or Never for this window.
2. As a user who says Yes, I see my tab strip reorganized into a handful of named, colored groups within a few seconds.
3. As a user, I see a list of duplicate and stale tabs with checkboxes and nothing closes until I press Confirm.
4. As a user who dislikes the result, I press Undo and the groups dissolve back to how they were.
5. As a user, I can change the threshold and paste my API key from the side panel without reloading the extension.
6. As a user who dismissed the prompt, I am not asked again until the window has grown by 5 more tabs.

## 5. Functional requirements

### 5.1 Detection (service worker)
- F1. Listen to `chrome.tabs.onCreated`, `onRemoved`, `onAttached`, `onDetached`. Maintain a count per `windowId`.
- F2. When a window's count goes from below to at or above the threshold, emit a `threshold_crossed` event for that window, once.
- F3. Per window, store `lastPromptedAt` and `lastPromptedCount`. Do not re-prompt unless count >= `lastPromptedCount + 5`.
- F4. Respect a per-window `never` flag. Respect a global `paused` flag.
- F5. Ignore incognito windows entirely.

### 5.2 Prompt (side panel)
- F6. On `threshold_crossed`, open the side panel for that window via `chrome.sidePanel.open({ windowId })`. Note: `sidePanel.open` requires a user gesture in some Chrome versions. Fallback if it throws: set the action badge to the tab count and show a `chrome.notifications` toast; clicking the toolbar icon opens the panel. **Person A tests this in the first 20 minutes.**
- F7. Panel shows: "This window has N tabs. Want me to organize them?" with buttons Yes, Not now, Never for this window.
- F8. Not now records the dismissal (F3). Never sets the flag (F4).

### 5.3 Collection
- F9. On Yes, gather every tab in the window: `id`, `index`, `title`, `url`, `pinned`, `audible`, `lastAccessed`, `groupId`, `favIconUrl`.
- F10. For each http(s) tab, inject a content script via `chrome.scripting.executeScript` that returns up to 300 characters of visible text (meta description if present, else first text of `<main>` or `<body>`). Timeout 1500 ms per tab. Skip discarded tabs and chrome:// pages. Missing excerpts are allowed; the plan must still succeed.
- F11. Normalize URLs locally: lowercase host, strip fragment, strip `utm_*`, `fbclid`, `gclid`, `ref`, `mc_*` parameters, strip trailing slash. Group by normalized URL. Every tab beyond the first in a group is a duplicate candidate. Keep the most recently accessed tab as the survivor.
- F12. Stale candidates: `lastAccessed` older than 24 hours, or already discarded by Chrome (memory saver), not pinned, not audible, not in a group already. The discarded signal is what makes stale tabs demo-able in a freshly opened window.

### 5.4 Planning (model call)
- F13. Send the tab list (with excerpts, duplicate candidates, stale candidates) to Claude Fable 5.1 in one request. Details in section 7.
- F14. The response must match the plan schema in section 8. Validate locally. If validation fails once, retry once with the validation error appended. If it fails twice, fall back to local domain grouping (F20).
- F15. Time budget: 8 seconds. Show a spinner and the phrase "Reading your tabs" while waiting.

### 5.5 Apply
- F16. Take a snapshot: for every tab in the window, record `tabId -> groupId` and, for each existing group, its title and color.
- F17. For each plan group, `chrome.tabs.group({ tabIds, createProperties: { windowId } })`, then `chrome.tabGroups.update(groupId, { title, color, collapsed: false })`.
- F18. Tabs the plan leaves unassigned stay ungrouped. Pinned tabs are never grouped or moved.
- F19. Order groups in the tab strip in the order the plan lists them, using `chrome.tabGroups.move`.
- F20. Fallback plan (no model): one group per registrable domain with 2 or more tabs, titled with the domain, colors cycled. Singletons ungrouped.

### 5.6 Review and close
- F21. After apply, the side panel shows two sections: Duplicates and Stale. Each row: favicon, title, domain, reason, checkbox. Duplicates are checked by default. Stale are unchecked by default.
- F22. Confirm closes checked tabs with `chrome.tabs.remove`. Before closing, record their URLs and titles in `lastClosed` so they can be reopened.
- F23. A "Reopen closed tabs" link restores every tab from `lastClosed` into the same window.
- F24. Skip leaves everything open.

### 5.7 Undo
- F25. Undo ungroups all tabs the run grouped, then re-creates the groups from the snapshot with their original titles and colors. Closed tabs are not reopened by Undo; that is F23.
- F26. Redo re-applies the last plan.
- F27. Only the last run is undoable.

### 5.8 Settings
- F28. Side panel Settings section: threshold (number, min 5, max 100), re-prompt delta (default 5), stale age in hours (default 24), model provider (dropdown, populated from `PROVIDERS` in `agent/providers.js`), model (dropdown, populated from the selected provider's `models` list, first option is the provider default), API key (password field, one stored per provider in `settings.apiKeys`, label comes from the provider's `keyLabel`), grouping basis (see section 6), pause toggle, "Reset Never list."
- F29. Settings persist in `chrome.storage.local` and take effect immediately without reload.

## 6. Grouping basis (CLOSED)

Use Hybrid option (#C below): 

| Option | What the model does | Pros | Cons |
|---|---|---|---|
| A. By website | Group by domain. No model needed for grouping. | Trivial, deterministic, instant | Chrome already does this. Weak demo. |
| B. By task | Model infers the user's activities ("Apartment hunt", "Q3 planning doc", "React debugging") and assigns each tab to one. | Novel, impressive, exactly the pitch | Needs page excerpts, occasionally wrong |
| C. Hybrid (recommended) | Model groups by task. Domain grouping is the deterministic fallback (F20) and is used for any tab the model leaves unassigned. User can switch basis in Settings. | Best demo with a safety net | Slightly more code, mostly already required by F14 |

Decision needed by 1:15 pm. It changes Person B's prompt but not the schema.

## 7. Model integration

**Provider selection:** `agent/config.js` is the single file that picks the model. It exports `MODEL_CONFIG = { provider, overrides, timeoutMs }`. `agent/providers.js` holds one adapter per provider; each adapter exposes `{ label, keyLabel, hosts, defaults, call() }`. Two ship today:

| Name | Endpoint | Default model | Structured output |
|---|---|---|---|
| `anthropic` (default) | `POST https://api.anthropic.com/v1/messages` | `claude-fable-5-1` | Native `output_config.format` json_schema |
| `openai` | `POST https://api.openai.com/v1/chat/completions` | `gpt-5.6-terra` (also Luna, Sol, GPT-6 Astra) | `response_format: json_schema` strict, plus schema in the system prompt |
| `nvidia` | `POST https://integrate.api.nvidia.com/v1/chat/completions` (OpenAI-compatible NIM) | `deepseek-ai/deepseek-v4-flash-0731` with thinking off (also Nemotron 3 Super, gpt-oss-20b, GLM 5.3 Flash, Kimi K3) | No `response_format` (DeepSeek hangs when it is sent); the schema goes in the system prompt and local validation (F14) is the contract |

Each provider lists its selectable models in `PROVIDERS[name].models`. The Settings model dropdown shows only the selected provider's list, so the open models appear only when NVIDIA is chosen; nobody types a model id. NVIDIA ids were copied from NVIDIA's own list at `GET https://integrate.api.nvidia.com/v1/models` on Sep 12 2026 (`deepseek-ai/deepseek-v4-pro-0813` is listed there but deprecated Sep 13, and `moonshotai/kimi-k2.6` returns 404, so both are excluded). Measured from the extension on a small prompt: DeepSeek V4 Flash 0.4 s, Nemotron 3 Super 1 s, gpt-oss-20b 1.6 s, GLM 5.3 Flash 6 s (thinking cannot be disabled), Kimi K3 over 40 s; Nemotron 3 Ultra and Gemma 4 timed out at 30 s and are excluded. Model entries may carry `extra` request fields; DeepSeek uses `chat_template_kwargs.thinking: false`. OpenAI ids were copied from platform.openai.com/docs/models the same day.

Switching provider is a one-line change in `agent/config.js` plus the matching key in Settings, or a dropdown change in Settings at runtime without a reload (F28, F29). Both OpenAI and NVIDIA adapters come from one `openaiCompatible()` factory, so any other OpenAI-style endpoint is a new `PROVIDERS` entry with a different `baseUrl`.

**Where the call runs:** the extension service worker, using `fetch`. No build step, no bundler, no SDK. The API key is read from `chrome.storage.local`. List every provider host in `host_permissions` (`https://api.anthropic.com/*`, `https://api.openai.com/*`, `https://integrate.api.nvidia.com/*`) so requests are not subject to page CORS. Anthropic requests send `anthropic-dangerous-direct-browser-access: true`.
**Isolation:** `agent/plan.js` exports `async function planTabs(tabs, settings) -> Plan`. It calls `resolveProvider(settings)` from `agent/providers.js`, hands the system prompt, user payload, and schema to `provider.call()`, then parses and validates. Nothing outside `agent/` knows which provider is behind it.

**Anthropic request shape (the `anthropic` adapter)**

```json
{
  "model": "claude-fable-5-1",
  "max_tokens": 4096,
  "output_config": {
    "effort": "low",
    "format": { "type": "json_schema", "schema": { "...see section 8..." } }
  },
  "fallbacks": "default",
  "system": "You organize browser tabs...",
  "messages": [
    { "role": "user", "content": "<JSON list of tabs and candidates>" }
  ]
}
```

Headers: `content-type: application/json`, `x-api-key: <key>`, `anthropic-version: 2023-06-01`, `anthropic-beta: server-side-fallback-2026-07-01`.

**Open model rules that matter (the `nvidia` adapter)**
- Send `temperature` (default 0.2) and `max_tokens`. Do not send `output_config`, `effort`, or `anthropic-*` headers.
- Some open models wrap JSON in a markdown fence or emit reasoning text first. The adapter strips fences and takes the outermost `{...}` before returning. F14 validation and retry still apply.
- Confirm the exact model id on the model's page at build.nvidia.com before the demo. Ids change between releases.
- Latency varies more than Fable. Keep the 15 s hard timeout (N2) and the domain fallback (F20).

**Fable 5.1 rules that matter here (the `anthropic` adapter)**
- Do not send a `thinking` parameter. Thinking is always on. Depth is controlled by `output_config.effort`. Use `low` for speed; raise to `medium` only if plans look thin.
- Do not send `temperature`, `top_p`, or `top_k`. They are rejected.
- Do not use forced `tool_choice`. Structured output via `output_config.format` is the right tool for "just give me JSON."
- Check `stop_reason` before reading content. If it is `refusal`, treat it like a validation failure (F14). `fallbacks: "default"` makes this rare.
- The JSON is in `content[0].text`. Parse it with `JSON.parse`, never string matching.

**System prompt (Person B owns; draft)**
> You organize a person's open browser tabs into a small number of groups based on what they are trying to accomplish, not which website a tab is on. Prefer 3 to 6 groups. Group names are 1 to 3 words, specific, in title case. Assign each tab to exactly one group or leave it unassigned if it fits nowhere. Pick a distinct color per group from the allowed list. Confirm or reject each duplicate and stale candidate; reject a stale candidate if it looks like reference material the person will want again. Return only the JSON.

**User message:** a JSON object `{ "tabs": [...], "duplicate_candidates": [...], "stale_candidates": [...], "grouping_basis": "task" | "website", "max_groups": 6 }`.

**Budget:** a 25-tab window with excerpts is roughly 6K input tokens and under 1K output. At Fable pricing that is a few cents per run.

## 8. Plan schema (the A/B contract, freeze by 1:00 pm)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["groups", "assignments", "duplicates", "stale", "summary"],
  "properties": {
    "summary": { "type": "string", "description": "One sentence shown to the user, e.g. 'Grouped 22 tabs into 4 tasks, found 3 duplicates.'" },
    "groups": {
      "type": "array",
      "maxItems": 8,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["key", "title", "color"],
        "properties": {
          "key": { "type": "string" },
          "title": { "type": "string" },
          "color": { "type": "string", "enum": ["grey","blue","red","yellow","green","pink","purple","cyan","orange"] }
        }
      }
    },
    "assignments": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["tab_id", "group_key"],
        "properties": {
          "tab_id": { "type": "integer" },
          "group_key": { "type": "string" }
        }
      }
    },
    "duplicates": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["tab_id", "keep_tab_id", "reason"],
        "properties": {
          "tab_id": { "type": "integer" },
          "keep_tab_id": { "type": "integer" },
          "reason": { "type": "string" }
        }
      }
    },
    "stale": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["tab_id", "reason"],
        "properties": {
          "tab_id": { "type": "integer" },
          "reason": { "type": "string" }
        }
      }
    }
  }
}
```

The color enum is exactly Chrome's `tabGroups.ColorEnum`. Local validation after parse: every `tab_id` exists in the window, every `group_key` exists in `groups`, no tab assigned twice, no pinned tab assigned.

## 9. Architecture

```
manifest.json
background.js          service worker: counting, threshold, messaging, apply, undo, redo, replay
sidepanel.html/.js     prompt, spinner, review checklist, settings, hidden dev section (Alt+Shift+D)
content/excerpt.js     injected on demand, returns page excerpt
agent/plan.js          planTabs(): builds prompt, calls the active provider, validates plan
agent/config.js        MODEL_CONFIG: the one file to edit to swap the model (provider, model id, effort)
agent/providers.js     PROVIDERS registry: anthropic, openai, nvidia; each lists its models; resolveProvider()
agent/local.js         normalizeUrl(), findDuplicates(), findStale(), domainFallbackPlan()
agent/schema.json      the plan schema above
demo/tabs.json         Person C's messy window as a URL list, also B's test fixture
demo/open-demo.js      opens demo/tabs.json into a fresh window; discards the tabs marked stale
icons/                 toolbar and notification icons
test/local.test.js     Node unit tests for agent/local.js and plan validation (`npm test`, no deps)
```

**Permissions:** `tabs`, `tabGroups`, `sidePanel`, `storage`, `scripting`, `notifications`. **Host permissions:** `<all_urls>` (for excerpts), `https://api.anthropic.com/*`, `https://api.openai.com/*`, and `https://integrate.api.nvidia.com/*`. Adding a provider means adding its host here; `host_permissions` is static in MV3.

**Messaging:** side panel and service worker talk over `chrome.runtime.sendMessage` with `{ type, windowId, payload }`. The panel sends requests; the worker pushes `STATE` with the window's full panel state `{ phase, count, summary, groups, review, canUndo, canRedo, closedCount, message }` where `phase` is one of `idle | prompt | planning | review | done | error`. Panel to worker types: `GET_STATE`, `ORGANIZE`, `DISMISS`, `NEVER`, `CONFIRM_CLOSE`, `SKIP_CLOSE`, `REOPEN`, `UNDO`, `REDO`, `REPLAY`, `SETTINGS_CHANGED`, `RESET_NEVER`, `OPEN_DEMO`. Per-window panel state is kept in `chrome.storage.session` so it survives service worker restarts.

**State in `chrome.storage.local`:**
```
settings: { threshold, repromptDelta, staleHours, provider, model, apiKeys: { [provider]: key }, groupingBasis, paused }
windows:  { [windowId]: { lastPromptedCount, never } }
lastRun:  { windowId, snapshot, plan, createdGroupIds, undone, closed: [{url,title}] }
```

## 10. Non-functional requirements

- N1. Prompt appears within 500 ms of crossing the threshold.
- N2. Plan applied within 8 s for up to 40 tabs; hard timeout at 15 s then fallback plan.
- N3. Extension works offline for the demo via a cached plan (`lastRun.plan`) replayed with a "Replay last plan" button in the hidden dev section (Alt+Shift+D in the panel) or the `Cmd/Ctrl+Shift+Y` extension command.
- N4. API key never leaves `chrome.storage.local` except in the request header to api.anthropic.com. Never logged.
- N5. Page excerpts are sent to the model and not stored.
- N6. No external dependencies. Plain JavaScript, no bundler.

## 11. Demo script (Person C)

1. Fresh window opened from `demo/tabs.json`: 22 tabs. Two work projects, a trip, shopping, three duplicates, two stale tabs. Open it from the side panel's hidden dev section (Alt+Shift+D, "Open demo window"). The opener pre-sets the window so the prompt fires after exactly two more tabs.
2. Open two more tabs by hand. The toolbar badge shows 24 and a toast appears (see section 14, item 3). Click the toolbar icon. The side panel opens with the prompt.
3. Click Yes. Spinner for a few seconds. Tab strip reorganizes into 4 or 5 named colored groups.
4. Panel shows 3 duplicates checked and 2 stale unchecked. Check one stale, press Confirm. Four tabs close.
5. Press Undo. Groups dissolve. Press Redo. They return.
6. Open Settings, change threshold to 10, show that it took effect.
Backup: screen recording of the same flow, recorded by 3:15.

## 12. Stretch (only after 2:45 pm and only if everything above works)

- S1. Move related tabs from other windows into this window's groups.
- S2. Collapse groups the user has not touched in an hour.
- S3. Natural language "find my tab" in the side panel using the same excerpt data.

## 13. Risks

| Risk | Mitigation |
|---|---|
| `sidePanel.open` refuses without a user gesture | F6 fallback to badge plus notification. Test first. |
| Model output fails schema | Structured output format plus local validation plus one retry plus domain fallback. |
| Excerpt injection slow on heavy pages | 1500 ms per-tab timeout, excerpts optional. |
| Demo Wi-Fi fails | Cached plan replay, backup video. |
| Judges expect an OpenAI or open-source model | Provider isolated behind `agent/config.js` and `agent/providers.js`. Switching to Kimi or GLM on NVIDIA NIM is one line plus a key. Be ready to demo the switch live. |

## 14. Open items

1. **Grouping basis** (section 6). Recommend C. Decide by 1:15.
2. Who holds the API key for the demo machine, and is it funded.
3. ~~Side panel `open()` gesture behavior on the demo machine's Chrome version.~~ RESOLVED 1:50 pm on Chrome 152: `sidePanel.open` throws when called from a `tabs.onCreated` handler (no user gesture). The F6 fallback fires instead: badge shows the count, a notification appears, and clicking the toolbar icon or the notification opens the panel in the prompt state. Demo step 2 should say "the badge lights up and a toast appears" rather than "the side panel slides in".

## 15. Acceptance checklist

- [ ] Open 15 tabs in a new window, panel appears once. Open 3 more, no re-prompt. Open 5 more, re-prompt.
- [ ] Yes produces named, colored groups from a real model plan.
- [ ] Duplicate rows checked by default, stale rows unchecked. Confirm closes only checked rows.
- [ ] Reopen closed tabs restores them.
- [ ] Undo restores pre-run groups. Redo re-applies.
- [ ] Threshold change in Settings takes effect without reload.
- [ ] Killing the network and pressing Replay still reorganizes the tab strip.
- [ ] Setting `provider: "nvidia"` in `agent/config.js` (or via Settings) and entering an NVIDIA key produces a valid plan from an open model.
