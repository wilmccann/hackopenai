# HackyTab Agent

A Chrome extension that notices when a window gets crowded, offers to help, and then groups, names, colors, and dedupes your tabs based on what you are doing. It asks before it closes anything. Spec: [SPEC.md](SPEC.md). Plan: [PROJECT.md](PROJECT.md).

## Run it

1. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, pick this folder. Chrome 121 or newer.
2. Click the HackyTab toolbar icon to open the side panel. Open **Settings** and paste an API key.
3. Open 15 tabs in one window. The panel offers to organize them.

No build step, no dependencies. Edit a file, then click the reload icon on `chrome://extensions` (Developer mode must be on, or the reload disables the extension). Note that Chrome caches the MV3 service worker, so re-installing the same version without a reload keeps the old `background.js`.

From the command line, `python3 tools/run-chrome.py` launches Google Chrome with a throwaway profile and loads the extension over a private DevTools pipe. The scratch profile holds any API key you paste into Settings and is deleted when the script exits (pass `--keep-profile` to keep it, then delete it yourself). Security notes: [SECURITY.md](SECURITY.md).

## Pick the model

Edit [agent/config.js](agent/config.js). Set `provider` to `"anthropic"` (Claude Fable 5.1, default), `"openai"` (GPT-5.6 Terra by default), or `"nvidia"` (open models on NVIDIA NIM: DeepSeek V4 Flash by default, plus Nemotron 3 Super, gpt-oss-20b, GLM 5.3 Flash, Kimi K3). The Settings panel has a provider dropdown and a model dropdown that only lists the chosen provider's models. Keys are entered in Settings and stored in `chrome.storage.local`, never in the repo.

To add another provider, add an entry to `PROVIDERS` in [agent/providers.js](agent/providers.js) and its host to `host_permissions` in [manifest.json](manifest.json).

## Grouping

Tabs are grouped by **category**: Video, Sports, News, Retail, Business, in that order on the tab strip. Inside a group, tabs are ordered by website. Anything that fits no category stays ungrouped, and a category needs at least two tabs to become a group. Settings offers **By website** as the alternative. When the model is unavailable, a local domain-to-category map in [agent/local.js](agent/local.js) produces the same layout.

## Demo

One command gives a clean starting point every time:

```bash
tools/demo.sh
```

It opens Chrome with a throwaway profile, loads the extension, and opens the 23 tabs from [demo/tabs.json](demo/tabs.json) in a fresh window: Google search, Gmail, Calendar, three news tabs (two nytimes.com, news.google.com, plus one duplicate), six retail sites, two business, two sports, three video, and three stale tabs that are discarded so they show up in the clean-up list. Open two more tabs by hand and the prompt appears. Quit Chrome or press Ctrl+C to finish; the profile is deleted (pass `--keep-profile` to keep it). Any API key must be entered in Settings after each launch.

The same window can be opened from inside the extension: press **Alt+Shift+D** in the side panel to reveal the dev section.

- **Open demo window** opens the tabs from [demo/tabs.json](demo/tabs.json). Open two more tabs by hand and the prompt appears.
- **Replay last plan** re-applies the last cached plan without a network call (offline fallback). Also bound to Cmd/Ctrl+Shift+Y.

## Tests

```bash
npm test
```

Runs the Node unit tests for the local logic (URL normalization, duplicates, stale, domain fallback, plan validation) and the security invariants in [SECURITY.md](SECURITY.md) (provider whitelist, fixed endpoints, text sanitizing, no HTML sinks). No Chrome needed.

## Layout

```
manifest.json          MV3 manifest
background.js          service worker: detection, messaging, apply, undo, redo, replay
sidepanel.html/.js     prompt, spinner, review checklist, settings
content/excerpt.js     injected on demand, returns up to 300 chars of page text
agent/config.js        the one file to edit to swap the model
agent/providers.js     provider adapters: anthropic, openai, nvidia (each lists its models)
agent/plan.js          planTabs(): prompt, call, validate, retry
agent/local.js         normalizeUrl, findDuplicates, findStale, categoryOf, categoryFallbackPlan, orderPlan, domainFallbackPlan
agent/schema.json      the plan JSON schema (the A/B contract)
demo/                  demo tab set and opener
test/                  Node unit tests
tools/demo.sh, demo.pl launch Chrome with a scratch profile, load the extension, open the demo tabs
tools/run-chrome.py    same launch without the demo tabs
SECURITY.md            threat model, what is stored where, mitigations
```
