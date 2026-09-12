# HackyTab Agent

**Detect, confirm, and organize your browser tabs based on context.**

HackyTab Agent is a Chrome extension that notices when a browser window has
become crowded and offers to tidy it up. It watches only the number of open
tabs. Once a window reaches a threshold you choose (fifteen by default), a small
badge appears on the toolbar icon and a short notification lets you know help is
available. Nothing happens until you say so.

## Detect

When you click the icon, a side panel opens with a single question: *this window
has 23 tabs, want me to organize them?* You can answer **Yes**, **Not now**, or
**Never for this window**. Not now waits until you have opened a few more tabs
before asking again. Never keeps the extension quiet in that window for good.

## Organize by context

If you say yes, the extension reads the titles and addresses of your open tabs,
and optionally a sentence or two from each page, and asks an AI model to sort
them into a small set of familiar categories: **Video, Sports, News, Retail, and
Business**. The result is applied as Chrome tab groups, each named and colored,
arranged left to right in that same order. Inside a group, tabs are lined up by
website, so all your YouTube tabs sit together and your shopping sites appear in
order. Tabs that fit no category, such as your email or calendar, are left where
they are and never grouped. A category becomes a group only when at least two
tabs belong to it.

## Confirm what to close

At the same time, the extension looks for tabs you probably no longer need.
**Duplicates**, meaning two tabs open to the same page, are listed with the extra
copy pre-checked for closing. **Stale** tabs, meaning pages you have not looked
at in a day or that Chrome has already put to sleep, are listed unchecked so you
can decide. Nothing closes until you review the list and press Confirm. Any tab
you close can be reopened from the panel.

## Always reversible

Every change can be undone. **Undo** puts the groups and the original tab order
back exactly as they were, and **Redo** applies the plan again. If the AI model
is slow or unavailable, the extension falls back to a built-in list of well-known
websites and produces the same category layout on its own, so it still works
offline.

## Your data stays with you

The extension sends only what it needs to produce a plan: tab titles, web
addresses stripped of tracking and search parameters, and short page excerpts
that you can switch off. It never reads pinned tabs, tabs already in a group, or
anything in an incognito window. Your API key is stored only inside your browser
and is never shown again after you paste it. You choose the AI provider in
Settings (Anthropic, OpenAI, or open-source models on NVIDIA), and the extension
talks only to that provider.

## In short

HackyTab Agent turns a messy window of two dozen tabs into a handful of labeled
groups in a few seconds, tells you which tabs are safe to close, and lets you
take it all back with one click.
