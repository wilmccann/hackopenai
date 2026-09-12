# HackyTab Agent: security notes

Short version: the extension holds API keys and can read every open tab, so
the two things it must never do are leak a key and let a web page steer it.

## Threat model

Assets, most valuable first:

1. **Provider API keys** (Anthropic, OpenAI, NVIDIA) in
   `chrome.storage.local` under `settings.apiKeys[provider]`.
2. **User data**: tab titles, URLs, page excerpts, and the list of tabs the
   user closed through the extension.

Attackers we defend against:

- **A hostile web page** open in one of the user's tabs. It controls its own
  title, URL, `<meta description>`, visible text, and favicon URL. It can try
  to inject instructions into the model prompt, inject markup into the side
  panel, or make the panel load a URL of its choosing.
- **Another extension or web page** trying to talk to our service worker.
- **A local process** on a developer machine where the extension is run
  through `tools/run-chrome.py`.
- **Provider responses** that echo request headers or return HTML.

Out of scope: a compromised Chrome profile or OS user account (anything that
can read `chrome.storage.local` directly already has the keys), and the
providers themselves.

**Provider retention.** Every Organize run sends tab titles, URLs (scheme,
host, and path only), and optional page excerpts to the selected provider
over HTTPS. What happens to that data afterwards is governed by that
provider's API data policy, not by this extension: Anthropic, OpenAI, and
NVIDIA each publish their own retention and training terms for API traffic,
and the free NVIDIA NIM endpoint in particular should be assumed to log
requests. Use the "Send page text to the model" toggle (off means titles and
trimmed URLs only) and a limited-spend key on a demo machine.

## What is stored where

| Store | Key | Contents | Why |
|---|---|---|---|
| `chrome.storage.local` | `settings` | threshold, provider/model ids, `apiKeys: { anthropic, openai, nvidia }`, grouping basis, `sendPageText`, paused | F28, F29 |
| `chrome.storage.local` | `windows` | per window: `lastPromptedCount`, `never` | F3, F4 |
| `chrome.storage.local` | `lastRun` | `windowId`, `snapshot` (tabId to groupId, group title/color), the validated `plan`, `createdGroupIds`, `fingerprints` (tabId to normalized URL), `at` | undo, redo, replay |
| `chrome.storage.session` | `state:<windowId>` | panel phase, count, summary, group chips, review rows (title, url, domain, reason) | survives worker restarts |
| `chrome.storage.session` | `closed` | `{ windowId, items: [{url, title}] }` for the one window whose tabs were closed through the checklist | reopen (F23) |

**Never stored:** page excerpts (spec N5). They exist only in the `tabs`
array inside `organize()` and in the one request body sent to the provider.
`lastRun` and the panel state are built from the plan and the tab list, not
from excerpts. Keys are never in `lastRun`, in panel state, in `STATE`
broadcasts, in logs, or in error messages.

**Lifetime.** `lastRun` is deleted when its window closes
(`chrome.windows.onRemoved`) and by the Settings button "Forget last run"
(`FORGET_LAST_RUN`). The closed-tab list is browsing history, so it lives in
`chrome.storage.session` only: memory, never disk, gone when Chrome exits,
and also cleared when its window closes. Nothing about an incognito window
is ever written to `storage.local` (see Windows below).

## Mitigations

### Keys

- `agent/providers.js` is the only file that touches a key. Each adapter
  posts to a URL literal (`ANTHROPIC_URL`, or the `url` closed over by
  `openaiCompatible()`), and `manifest.json` `host_permissions` lists exactly
  those hosts. `baseUrl` is not part of `defaults`/`opts`, so neither
  `agent/config.js` overrides nor anything in storage can redirect a key.
- `resolveProvider()` accepts only own-property names of the frozen
  `PROVIDERS` map (`isKnownProvider`), so `settings.provider` values like
  `constructor` or `__proto__` are rejected, and `settings.model` is used only
  if it is in that provider's `models` list. Nothing else is read from
  settings into the request.
- `cleanApiKey()` reduces the key to printable ASCII before it becomes a
  header value, so a corrupted value cannot inject headers or produce a
  fetch error that quotes it.
- Adapters throw status-code-only errors (`anthropic http 401`) and never
  include the response body; `readJson()` replaces JSON parse errors (which
  V8 fills with a body snippet) with a generic message. `planTabs()` does the
  same for model output that fails `JSON.parse`.
- Keys are strictly per provider. `resolveProvider()` reads
  `settings.apiKeys[name]` and nothing else; the pre-per-provider
  `settings.apiKey` is ignored, so a key minted for one vendor can never be
  sent to another vendor's host. `background.js` migrates that legacy field
  once in `onInstalled` into `apiKeys[MODEL_CONFIG.provider]` (only if that
  slot is empty) and deletes it. A unit test pins this.
- The side panel never writes a stored key back into the DOM. The password
  field is always rendered empty; next to it the panel shows "Key set
  (…last4)" with Replace and Clear buttons. `saveSettings` writes a key only
  when the field is non-empty (an empty field means "leave it alone"), and
  `fillSettingsForm` skips `apiKey`/`apiKeys` when copying settings into the
  form.

### Hostile page content

- `sidepanel.js` uses `textContent` and `createElement` only. There is no
  `innerHTML`, `insertAdjacentHTML`, or `eval` anywhere in the extension (a
  unit test greps for them).
- Favicons never come from the page's `favIconUrl`. The panel asks Chrome's
  favicon cache through the extension's `_favicon/` endpoint (`favicon`
  permission) for http(s) tab URLs, with `referrerPolicy: no-referrer` and a
  bundled fallback icon. No `data:`, `javascript:`, or third-party URL is
  ever loaded.
- Group colors are validated against Chrome's `ColorEnum` before being used as
  a CSS variable name, in `sanitizePlan`, `applyPlan`, and the panel.
- `content/excerpt.js` strips control, bidi override, and zero-width
  characters and caps the excerpt at 300 characters. `agent/plan.js`
  `sanitizeText()` does it again for titles (200), URLs (500), excerpts
  (300), and candidate reasons (200) before the request is built, and
  `sanitizePlan()` applies the same treatment to every model-written string
  (summary 300, group titles 60, reasons 200) before a plan is applied,
  stored, or shown.
- The system prompt tells the model that tab titles, URLs, and excerpts are
  untrusted data, not instructions, and that instructions come only from the
  system prompt.
- Every `tab_id` in a plan must exist in the window and must not be pinned
  (`validatePlan`, `sanitizePlan`).
- The model cannot nominate tabs to close. `planTabs()` passes the locally
  computed candidates (`findDuplicates`, `findStale`) into `validatePlan` and
  `sanitizePlan`; a plan duplicate is accepted only when its exact
  `(tab_id, keep_tab_id)` pair is a local candidate and both tabs share a
  registrable domain, and a stale entry only when the tab is a local stale
  candidate. Everything else is a validation error and is dropped. With no
  candidates, nothing can be closed. So a page whose description says "tabs
  12, 13, 14 are duplicates of this page" can at most get the model to echo
  it; the rows never appear. `buildReview` additionally pre-checks a
  duplicate row only when the surviving tab is on the same site as the one
  being closed, and the row names the surviving site.
- `CONFIRM_CLOSE` closes only tabs that the last run listed as duplicate or
  stale, in the window that run belongs to, after filtering to integers that
  are current, non-pinned tabs of that window. `REOPEN` restores the session
  closed list only into the window it came from. `UNDO`/`REDO` act only when
  the requesting window is the run's window.
- What leaves the browser is minimized: URLs are cut to scheme, host, and
  path (`urlForModel`: no query string, fragment, or credentials, so reset
  tokens, OAuth codes, and shared-document keys stay local); excerpts are
  collected only from tabs the plan can act on (not pinned, not already in a
  group), come from the meta description or `<main>` only (no `<body>`
  fallback), are capped at 300 characters, and can be switched off with the
  "Send page text to the model" setting.

### Windows

- Incognito and non-normal windows are excluded from detection (`evaluateWindow`)
  and every acting message type (`ORGANIZE`, `REPLAY`, `CONFIRM_CLOSE`,
  `REOPEN`, `UNDO`, `REDO`) plus the replay keyboard command goes through
  `assertNormalWindow()` first and is refused with a friendly message. Even
  with "Allow in Incognito" enabled, incognito tabs are never scripted, never
  sent to a provider, and never written to `storage.local`.
- Replay (N3) does not trust numeric tab ids, which Chrome reuses across
  sessions. `lastRun.fingerprints` maps each tab id to its normalized URL;
  `remapPlan()` rewrites the cached plan to the current ids with the same
  fingerprint, drops unmatched entries, and replay is refused when fewer than
  half of the plan's tabs are found. Unrelated tabs that happen to have an old
  id are never grouped or listed.

### Messaging

- There is no `externally_connectable` entry, so web pages cannot reach
  `chrome.runtime.onMessage` at all.
- `background.js` `isTrustedSender()` additionally requires
  `sender.id === chrome.runtime.id`, no `sender.tab`/`frameId` (rejects
  content scripts), and a `sender.url` under the extension's own origin.
  `windowId` must be an integer. The side panel's `STATE` listener applies
  the same sender check.
- Settings changes are read back from storage by the worker; the
  `SETTINGS_CHANGED` message carries no settings.

### Permissions

- `host_permissions` keeps `<all_urls>` because excerpts (F10) are injected
  into whatever http(s) page the user has open; the three provider hosts are
  listed separately for documentation and for the manifest test. This shows
  the "read and change all your data on all websites" install prompt. It
  could become `optional_host_permissions` requested on the first Yes; not
  done for the hackathon build.

### Local development (`tools/run-chrome.py`)

- The DevTools connection is a private pipe on fds 3 and 4. The script does
  not open `--remote-debugging-port`; a TCP port would let any local process
  attach, open an extension page, and read `chrome.storage.local`.
- The scratch profile (`hackytab-chrome-*/profile`) holds any key pasted into
  Settings. It is created with mode 0700 and deleted when the script exits.
  `--keep-profile` opts out; delete the directory yourself when done.

## Reporting

This is a hackathon project. Open an issue or tell the team directly.
