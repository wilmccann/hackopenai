# HackyTab Agent: proactive tab organization for Chrome

**Hackathon:** Agents Everywhere: Beyond the Chatbot (AI Tinkerers x OpenAI), Sep 12 2026
**Team:** 3 people. **Hard stop:** 3:30 pm. **Time now:** 12:45 pm.
**Status:** CONFIRMED except grouping basis (see decisions). Detailed spec: SPEC.md.

## One-liner

A Chrome extension that notices when a window gets crowded, offers to help, and then groups, names, colors, and dedupes your tabs based on what you are actually doing. It asks before it closes anything.

## The problem

We all run several Chrome windows with 15 to 40 tabs each. Finding things is slow, related work is scattered across windows, and duplicates and dead tabs pile up. Chrome can group tabs by button and search them by string, but it never notices the mess, never understands the task behind the tabs, and never acts on its own.

## Why this fits the brief

The sponsor asked for agents that live inside tools people already use, not in a separate chat window. This agent lives in the browser tab strip. It is proactive (it triggers on a threshold), contextual (it reads what the tabs are about), and agentic (it acts, with approval, on the tabs themselves). The "asks then acts" loop is the whole demo.

## What it does (in scope)

1. **Detect.** Watch tab count per window. When a window crosses the threshold (default 15, user-configurable at any time from the side panel), fire once. Do not nag: after a dismissal, wait for N more tabs before asking again.
2. **Confirm.** Open the side panel with a small, non-blocking prompt: "This window has 22 tabs. Want me to organize them?" Yes / Not now / Never for this window.
3. **Understand.** Send tab title, URL, and a short page excerpt to the model. Get back a plan: named groups with colors, each tab assigned to one group, plus a list of exact duplicates and a list of stale candidates.
4. **Organize.** Apply the plan with the Chrome tabGroups API: create groups, name and color them, move tabs into them within the window.
5. **Ask before destructive steps.** Duplicates and stale tabs are shown as a checklist. Nothing closes until the user confirms. Closed tabs are listed so they can be restored.
6. **Undo.** One click reverts grouping for the last run.

## Not in scope today

- Moving tabs between windows (nice to have if everything else is done by 2:45).
- Natural language tab search ("find the Stripe pricing tab"). Same data layer, separate feature, later.
- Persisting groups across browser restarts or syncing across devices.
- Firefox, Safari, Edge.
- Reading page content beyond a short excerpt. No screenshots, no full DOM.
- Accounts, backend, billing. The extension calls the model API directly with a key set in the side panel.

## User flow for the demo

1. Open a deliberately messy window: 20 plus tabs mixing a work project, travel planning, shopping, docs, and three duplicate tabs.
2. Open two more tabs. The prompt appears.
3. Click Yes. Within a few seconds the tab strip reorganizes into named, colored groups.
4. A panel lists three duplicates and two stale tabs. Uncheck one, confirm the rest. They close.
5. Click Undo. Groups dissolve. Click Redo. They come back.
6. Total demo time under two minutes.

## How it works (high level)

- **Chrome extension, Manifest V3.** Service worker listens to tabs.onCreated and tabs.onUpdated. Popup or side panel for the prompt and the review checklist.
- **Permissions:** tabs, tabGroups, storage, scripting (for the page excerpt), activeTab.
- **Model:** Claude Fable 5.1 (`claude-fable-5-1`) via the Anthropic Messages API with a JSON schema output format. One call per organize run. The call lives behind one function, and `agent/config.js` selects the provider, so swapping to an open model such as Kimi or GLM on NVIDIA NIM is a one-line change. Input is a JSON list of tabs. Output is a fixed JSON schema: groups[], assignments[], duplicates[], stale[].
- **Stale heuristic:** last accessed more than 24 hours ago and not pinned, confirmed by the model as low value. Chrome exposes lastAccessed on tabs.
- **Duplicates:** exact URL match after stripping tracking params. Done locally, no model needed.
- **Storage:** chrome.storage.local for threshold, dismissals, API key, and the last plan for undo.
- **Prompt surface:** Chrome side panel, which also hosts the review checklist and settings.

## Team split

| Person | Owns | First milestone (by 1:30) |
|---|---|---|
| A | Extension shell: manifest, service worker, threshold detection, prompt UI, apply plan via tabGroups API, undo | Prompt fires on threshold and a hard-coded plan groups tabs |
| B | Agent: prompt design, JSON schema, Claude call, duplicate and stale logic, tab excerpt collection | Given a real tab list, returns a valid plan in under 5 seconds |
| C | Demo and submission: messy demo window, pitch, writeup, screenshots, video, README. Joins A on the review checklist UI after 1:30 | Demo tab set built and pitch draft written |

Integration point: A and B agree on the plan JSON schema before 1:00 and do not change it after.

## Timeline

| Time | Goal |
|---|---|
| 12:45 to 1:00 | Confirm this doc. Agree on JSON schema. Create repo skeleton. |
| 1:00 to 1:30 | Milestones above. |
| 1:30 to 2:15 | Wire A and B together. Real plan applied to real tabs. Review checklist works. |
| 2:15 to 2:45 | Undo, edge cases, polish prompt copy. Freeze features at 2:45. |
| 2:45 to 3:15 | Rehearse the demo three times. Record a backup video. Write the submission. |
| 3:15 to 3:30 | Submit. Buffer. |

## Risks and fallbacks

- **Model returns malformed or slow output.** Structured outputs remove most of this. Fallback: group by domain locally so the demo still works.
- **tabGroups API surprises.** A tests it in the first 20 minutes with hard-coded data before anything else.
- **Live demo Wi-Fi fails.** Backup video recorded by 3:15. Cache the last plan so the demo can replay offline.
- **Scope creep.** Anything not in the "in scope" list waits until 2:45 and only if everything above works.

## Decisions (12:55 pm)

1. **Threshold:** default 15, user-configurable while the extension is running, from the side panel settings.
2. **Prompt surface:** Chrome side panel. It hosts the prompt, the review checklist, and settings.
3. **Grouping basis:** NOT DECIDED. Options are by task or project (more impressive, needs page excerpts) or by website (simpler, weaker demo). See SPEC.md section 6 for a recommended hybrid.
4. **Model:** Claude Fable 5.1 (`claude-fable-5-1`). Team decision. Note this is an OpenAI-sponsored event; the model call is isolated in one function so switching is cheap if judging criteria require it.
5. **Name:** HackyTab Agent.

## Pitch (draft, 30 seconds)

Chrome can group tabs when you push a button and search them when you type a string. It never notices you are drowning, never understands what you are working on, and never acts. HackyTab Agent does all three. It sees the window fill up, asks if you want help, reads what the tabs are about, and reorganizes them into named groups around your actual tasks. It flags the duplicates and the tabs you abandoned last week, and it does not close a single one until you say so. An agent that belongs in the tab strip, not in a chat window.

## Team split, explained

### Person A: the extension itself
Builds what runs inside Chrome. No AI in the first hour.
- **Manifest.** manifest.json declaring the extension, permissions (tabs, tabGroups, storage, scripting, sidePanel), and scripts.
- **Service worker.** Background script listening to tab created and updated events, counting tabs per window.
- **Threshold detection.** Fire once when a window crosses 15. Remember dismissals so it does not re-ask on tab 16, 17, 18.
- **Prompt UI.** The "This window has 22 tabs. Organize them?" surface with Yes / Not now / Never. Side panel recommended.
- **Apply plan.** Take a plan JSON (group name, color, tab ids) and make it real with the tabGroups API.
- **Undo.** Snapshot each tab's group before applying; undo restores the snapshot.
- **Done at 1:30:** open 16 tabs, prompt appears, click Yes, a hand-written fake plan groups the tabs.

### Person B: the brain
Builds one function: tab list in, plan out. Develops in a plain Node script, no Chrome APIs.
- **JSON schema.** Exact plan shape: groups (name, color), assignments (tab id to group), duplicates, stale. This is the contract with A. Frozen by 1:00.
- **Prompt design.** Group by task not website, short names, max six groups, stale only if clearly abandoned.
- **OpenAI call.** Responses API with structured outputs so the model must return valid JSON matching the schema.
- **Duplicate logic.** Local, no model. Strip tracking params, find exact URL matches.
- **Stale logic.** Not accessed in 24h and not pinned are candidates; model confirms.
- **Tab excerpt collection.** Content script grabbing the first few hundred characters of each page. B writes it, A wires it in.
- **Done at 1:30:** 25 real tabs in, sensible valid plan out, under five seconds.

### Person C: making it land
Owns everything judges see that is not code, then becomes A's second pair of hands.
- **Messy demo window.** About 22 real URLs mixing a work project, travel, shopping, docs, three deliberate duplicates, two stale tabs. Doubles as B's test data. Share by 1:00.
- **Pitch.** 30-second spoken version and two-minute demo script, rehearsed.
- **Writeup.** Submission text: problem, what it does, how it works, what is novel.
- **Screenshots, video, README.** Before/after tab strip shots, backup screen recording, standalone README.
- **Review checklist UI after 1:30.** Panel listing duplicates and stale tabs with checkboxes and Confirm.
- **Done at 1:30:** demo tab set shared, pitch draft written.

### How they connect
C's tab set feeds B's testing. B's schema is A's input. At 1:30 A swaps the fake plan for B's function.
