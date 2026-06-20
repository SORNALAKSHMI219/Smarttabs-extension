# SmartTabs — Semantic Tab Manager (Chrome Extension)

A Chrome extension that groups open tabs by topic, flags stale/duplicate tabs you
can safely close, and lets you save & restore whole browsing sessions.

## How to load it (no build step needed)

1. Open Chrome → go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder (the one containing `manifest.json`)
5. Click the SmartTabs icon in your toolbar to open the side panel (or it opens
   automatically when you click the extension icon)

That's it — no `npm install`, no build tools. It's all vanilla JS/HTML/CSS so
there's nothing to compile and nothing that can "fail to build" right before
your demo.

## Project structure

```
smarttabs/
├── manifest.json       Manifest V3 config — permissions, side panel, options page
├── background.js       Service worker — all logic lives here (see below)
├── sidepanel.html/.css/.js   Main UI: Groups / Cleanup / Sessions tabs
├── options.html/.js     Settings page — optional AI grouping + API key
└── icons/               Extension icons (generated programmatically)
```

## Architecture — what happens where

### 1. Tab metadata tracking (`background.js`)
Chrome doesn't track "how long has this tab been idle" by default, so the
service worker listens to `tabs.onCreated`, `tabs.onActivated`, and
`windows.onFocusChanged` to maintain a `{ openedAt, lastFocusedAt }` record per
tab in `chrome.storage.local`. This is the raw signal the Cleanup feature is
built on.

### 2. Topic clustering — two modes
- **Offline mode (default, no API key needed)**: `localCluster()` extracts
  keywords from each tab's title (stopword removal + lowercasing), then
  greedily clusters tabs using **Jaccard similarity** on keyword sets (plus a
  same-hostname shortcut). This is real, explainable NLP — no black box — and
  it's the right thing to point to if an examiner asks "is this just an API
  wrapper?"
- **AI mode (optional, user supplies their own Anthropic API key in
  Settings)**: `llmCluster()` sends just the tab titles + URLs (never full
  page content — privacy by design) to Claude, which returns topic groups with
  better, more human-readable names. This is the "smart upgrade path" — a
  good talking point on tradeoffs (cost/privacy vs. accuracy).

Either way, results are applied as **real native Chrome tab groups** via the
`chrome.tabGroups` API, so it looks and behaves like a first-class browser
feature, not a custom overlay.

### 3. Cleanup suggestions
`computeSuggestions()` flags two kinds of tabs:
- **Idle tabs**: not active, not playing audio, and untouched for >30 minutes
  (configurable)
- **Duplicate tabs**: same normalized URL open more than once

Nothing is closed automatically — the user reviews and checks tabs, which
matters for trust (mention this explicitly in your report as a UX decision).

### 4. Sessions
`saveSession()` snapshots the current window's tabs **and** their group
structure (name + color) into `chrome.storage.local`. `restoreSession()`
reopens everything in a new window and recreates the same tab groups.

## Suggested demo flow (for viva)

1. Open ~15 tabs across 3-4 different topics (e.g. some YouTube, some Stack
   Overflow, some shopping)
2. Open the side panel → **Groups** tab → click "Group my tabs" → show the
   real Chrome tab groups appearing, named automatically
3. Leave a few tabs untouched, switch to **Cleanup** → show idle/duplicate
   detection → close a couple
4. **Sessions** tab → save the current setup → close all tabs → restore the
   session and show everything (including groups) comes back exactly as it was
5. (Optional) Open **Settings**, flip on AI mode with a real API key, re-run
   grouping, and compare group names — great moment to talk about the
   offline-vs-AI tradeoff

## What to highlight as "novel" vs "already exists"

Be upfront about this if asked — it strengthens your report rather than
weakening it:
- Domain/rule-based tab grouping and basic session save/restore already exist
  in extensions like OneTab, Tab Session Manager, Auto-Group Tabs.
- What's not common: **content-aware semantic clustering** (not just
  domain/URL rules) combined with a **behavior-based close-suggestion engine**
  (idle-time + duplicate detection) and **session-level group restoration**,
  all in one tool, with an explicit offline-first / AI-optional design.

## Possible extensions if you have spare time before submission

- A small dashboard (tabs opened today, avg idle time, sessions saved) — cheap
  visual win for your report screenshots
- Keyboard shortcut to trigger grouping (`commands` API)
- Export a session as a shareable JSON/markdown reading list
