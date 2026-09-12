# HackyTab Agent

Detect, confirm, and organize your Chrome tabs based on context.

HackyTab Agent is a Chrome extension that notices when a window gets crowded, offers to help, and then groups, names, colors, and orders your tabs by category. It flags duplicate and stale tabs, asks before closing anything, and can undo everything with one click.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [How grouping works](#how-grouping-works)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Documentation](#documentation)
- [Security and privacy](#security-and-privacy)

## Features

- **Detects** a crowded window (15 tabs by default) and offers to help with a badge and a notification. Nothing happens until you say yes.
- **Organizes** tabs into Chrome tab groups by category: Video, Sports, News, Retail, Business. Groups appear in that order, and tabs within a group are ordered by website.
- **Confirms** before closing. Duplicate and stale tabs are listed in a checklist; you decide what goes.
- **Undo and redo** restore groups and the original tab order exactly.
- **Works offline.** If the model is slow or unavailable, a built-in domain-to-category map produces the same layout.
- **Swappable model provider:** Anthropic (default), OpenAI, or open-source models on NVIDIA NIM.

For the full plain-language description see [docs/DESCRIPTION.md](docs/DESCRIPTION.md).

## Requirements

- Google Chrome 121 or newer (macOS, Windows, or Linux).
- An API key for one provider (Anthropic, OpenAI, or NVIDIA). Optional: without a key the extension uses the offline fallback.
- For `tools/demo.sh`: macOS with Chrome installed at the default location, and the system Perl (already present on macOS). Set `CHROME=/path/to/chrome` to use a different install.
- For the tests: Node.js 18 or newer.

No build step and no dependencies.

## Quick start

The fastest way to see the extension working is the demo launcher:

```bash
tools/demo.sh
```

This opens Chrome with a throwaway profile, loads the extension, and opens a fresh window with 23 shuffled tabs from [demo/tabs.json](demo/tabs.json): news, retail, business, sports, video, three Google apps, three stale tabs, and one duplicate. Open two more tabs by hand, click the HackyTab toolbar icon, and press **Organize this window**.

## Usage

### 1. Try it with the demo launcher

```bash
tools/demo.sh
```

| Option | Effect |
|---|---|
| `--keep-profile` | Keep the scratch Chrome profile after Chrome quits. It may contain an API key you pasted; delete it yourself when done. |
| `CHROME=/path/to/chrome tools/demo.sh` | Use a Chrome binary other than `/Applications/Google Chrome.app`. |

What happens:

1. Chrome starts with a clean profile and the extension loaded from this folder.
2. A window opens with the 23 demo tabs. The three stale tabs are discarded after a few seconds so they count as stale.
3. Open two more tabs. The toolbar badge shows the count and a notification appears.
4. Click the toolbar icon. The side panel opens and asks to organize the window.
5. Press **Organize this window**. Groups form in category order. The panel lists duplicate and stale tabs; check what you want closed and press **Confirm**.
6. Press **Undo** to restore the original layout, **Redo** to apply it again.
7. Quit Chrome or press Ctrl+C in the terminal. The scratch profile is deleted.

The demo launcher runs without an API key, using the offline fallback. To try the model, open **Settings** in the side panel and paste a key after each launch (the profile is fresh every time).

`tools/demo.sh` is a thin wrapper around [tools/demo.pl](tools/demo.pl), which installs the extension over a private DevTools pipe because Chrome 137+ ignores the `--load-extension` flag. To launch a scratch Chrome without the demo tabs, use `python3 tools/run-chrome.py`.

### 2. Install it in your own Chrome

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.
3. Click the HackyTab toolbar icon to open the side panel. Open **Settings** and paste an API key for your chosen provider.
4. Open 15 tabs in one window. The badge lights up and the panel offers to organize them.

After editing a file, click the reload icon for the extension on `chrome://extensions`. Developer mode must stay on, or the reload disables the extension. Chrome caches the MV3 service worker, so reinstalling the same version without a reload keeps the old `background.js`.

### 3. Everyday use

- **Yes** organizes the window. **Not now** asks again after 5 more tabs. **Never for this window** keeps the extension quiet there.
- **Settings** (in the panel): threshold, re-prompt delta, stale age, grouping basis, model provider, model, API key, page-text toggle, pause.
- **Replay last plan** re-applies the last cached plan without a network call. Press **Alt+Shift+D** in the panel to reveal it, or use **Cmd/Ctrl+Shift+Y**. The same hidden section has **Open demo window**.

## Configuration

Edit [agent/config.js](agent/config.js) to pick the default model. Set `provider` to one of:

| Provider | Default model | Other models in the dropdown |
|---|---|---|
| `anthropic` (default) | Claude Fable 5.1 | |
| `openai` | GPT-5.6 Terra | GPT-5.6 Luna, GPT-5.6 Sol, GPT-6 Astra |
| `nvidia` | DeepSeek V4 Flash | Nemotron 3 Super, gpt-oss-20b, GLM 5.3 Flash, Kimi K3 |

The Settings panel has a provider dropdown and a model dropdown that lists only the chosen provider's models. Keys are entered in Settings and stored in `chrome.storage.local`, one per provider, never in the repo.

To add a provider, add an entry to `PROVIDERS` in [agent/providers.js](agent/providers.js) and its host to `host_permissions` in [manifest.json](manifest.json).

## How grouping works

Tabs are grouped by **category**: Video, Sports, News, Retail, Business, in that order on the tab strip. Inside a group, tabs are ordered by website. A category becomes a group only when at least two tabs belong to it; everything else stays ungrouped. Settings offers **By website** as the alternative basis.

The model proposes the plan; local code validates it against a fixed schema, rejects any title outside the category list, drops single-tab groups, and orders the result. When the model fails or times out, a domain-to-category map in [agent/local.js](agent/local.js) produces the layout on its own. The rules are F30 to F33 in [docs/SPEC.md](docs/SPEC.md).

## Testing

```bash
npm test
```

Runs the Node unit tests for the local logic (URL normalization, duplicates, stale detection, category and domain fallbacks, ordering, plan validation) and the security invariants (provider whitelist, fixed endpoints, text sanitizing, no HTML sinks). No Chrome needed.

## Project structure

```
manifest.json          MV3 manifest
background.js          service worker: detection, messaging, apply, undo, redo, replay
sidepanel.html/.js     prompt, spinner, review checklist, settings
content/excerpt.js     injected on demand, returns up to 300 chars of page text
agent/config.js        the one file to edit to swap the model
agent/providers.js     provider adapters: anthropic, openai, nvidia (each lists its models)
agent/plan.js          planTabs(): prompt, call, validate, retry
agent/local.js         normalizeUrl, findDuplicates, findStale, categoryOf, categoryFallbackPlan, orderPlan
agent/schema.json      the plan JSON schema
demo/tabs.json         the 23-tab demo set
demo/open-demo.js      opens the demo set in a fresh window
test/                  Node unit tests
tools/demo.sh, demo.pl launch a scratch Chrome, load the extension, open the demo tabs
tools/run-chrome.py    same launch without the demo tabs
docs/                  design, description, security, project plan
```

The architecture is section 9 of [docs/SPEC.md](docs/SPEC.md).

## Documentation

| Document | What it covers |
|---|---|
| [docs/DESCRIPTION.md](docs/DESCRIPTION.md) | What the extension does, in plain language |
| [docs/SPEC.md](docs/SPEC.md) | Design and requirements: features F1 to F33, model contract, storage, demo script (section 11) |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, what leaves the browser, what is stored where |
| [docs/PROJECT.md](docs/PROJECT.md) | Hackathon plan and decisions |

## Security and privacy

Only tab titles, URLs stripped of query strings and fragments, and optional short page excerpts are sent to the provider you chose. Pinned tabs, grouped tabs, and incognito windows are never read. The API key is stored in the browser only and is never shown again after you paste it. Details, including the red team and blue team review, are in [docs/SECURITY.md](docs/SECURITY.md).
