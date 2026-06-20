/**
 * SmartTabs background service worker.
 *
 * Responsibilities:
 *  1. Track per-tab metadata (openedAt, lastFocusedAt) that Chrome doesn't expose by default.
 *  2. Cluster open tabs into topics ("Semantic Grouping") — local bag-of-words fallback,
 *     or an LLM call if the user has configured an API key in Options.
 *  3. Score tabs for the "Cleanup Suggestions" feature (idle time + duplicates).
 *  4. Save/restore/delete "Sessions" (a snapshot of tabs + their group structure).
 *
 * All persistent data lives in chrome.storage.local under these keys:
 *   tabMeta   -> { [tabId]: { openedAt, lastFocusedAt } }
 *   sessions  -> [ { id, name, createdAt, groups: [{ name, color, tabs: [{title,url}] }] } ]
 *   settings  -> { apiKey, model, useLLM }
 */

const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","on","for","with","is","are","was","were",
  "this","that","it","its","as","at","by","be","from","your","you","how","what","why",
  "new","get","how-to","com","www","https","http","html","-","|","–","—",":","–"
]);

// ---------- Tab metadata tracking ----------

async function getTabMeta() {
  const { tabMeta } = await chrome.storage.local.get("tabMeta");
  return tabMeta || {};
}

async function setTabMeta(meta) {
  await chrome.storage.local.set({ tabMeta: meta });
}

async function touchTab(tabId, { opened = false, focused = false } = {}) {
  const meta = await getTabMeta();
  const now = Date.now();
  if (!meta[tabId]) meta[tabId] = { openedAt: now, lastFocusedAt: now };
  if (opened) meta[tabId].openedAt = now;
  if (focused) meta[tabId].lastFocusedAt = now;
  await setTabMeta(meta);
}

chrome.tabs.onCreated.addListener((tab) => touchTab(tab.id, { opened: true, focused: true }));

chrome.tabs.onActivated.addListener(({ tabId }) => touchTab(tabId, { focused: true }));

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (activeTab) touchTab(activeTab.id, { focused: true });
  } catch (e) { /* window may have closed */ }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const meta = await getTabMeta();
  delete meta[tabId];
  await setTabMeta(meta);
});

// ---------- Local (offline) topic clustering ----------
// Lightweight bag-of-words + Jaccard similarity clustering.
// No network call, no page-content scraping (privacy-friendly): we only use
// the tab title and hostname, which Chrome already exposes via chrome.tabs.query.

function extractKeywords(text) {
  return Array.from(
    new Set(
      (text || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    )
  );
}

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function localCluster(tabs, threshold = 0.18) {
  const items = tabs.map((t) => {
    let host = "";
    try { host = new URL(t.url).hostname.replace(/^www\./, ""); } catch (e) {}
    return { tab: t, keywords: extractKeywords(t.title), host };
  });

  const clusters = []; // [{ keywords:Set, host:Set, items:[] }]

  for (const item of items) {
    let placed = false;
    for (const cluster of clusters) {
      const sim = jaccard(item.keywords, cluster.keywords);
      const sameHost = cluster.hosts.has(item.host);
      if (sim >= threshold || sameHost) {
        cluster.items.push(item);
        item.keywords.forEach((k) => cluster.keywords.push(k));
        cluster.hosts.add(item.host);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({ keywords: [...item.keywords], hosts: new Set([item.host]), items: [item] });
    }
  }

  return clusters.map((c) => ({
    name: nameClusterLocally(c),
    tabIds: c.items.map((i) => i.tab.id),
  }));
}

function nameClusterLocally(cluster) {
  // Pick the most frequent meaningful keyword across the cluster as the group name.
  const freq = {};
  cluster.items.forEach((i) =>
    i.keywords.forEach((k) => (freq[k] = (freq[k] || 0) + 1))
  );
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    const word = sorted[0][0];
    return word.charAt(0).toUpperCase() + word.slice(1);
  }
  const host = [...cluster.hosts][0];
  return host || "Misc";
}

// ---------- LLM-powered clustering (optional, requires user's own API key) ----------

async function llmCluster(tabs, settings) {
  const payload = tabs.map((t) => ({ id: t.id, title: t.title, url: t.url }));
  const prompt =
    "Group the following browser tabs into 3-8 short topic clusters based on title and URL. " +
    "Respond with ONLY valid JSON, no prose, no markdown fences, in this exact shape: " +
    '{"groups":[{"name":"Short Topic Name","tabIds":[1,2,3]}]}. ' +
    "Every tabId must appear in exactly one group. Tabs:\n" +
    JSON.stringify(payload);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.model || "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status}`);
  }
  const data = await response.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  const cleaned = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  return parsed.groups || [];
}

// ---------- Group creation in the real Chrome UI ----------

const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

async function applyGroups(groups, windowId) {
  let colorIdx = 0;
  for (const group of groups) {
    const tabIds = group.tabIds.filter((id) => typeof id === "number");
    if (tabIds.length === 0) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, {
        title: group.name,
        color: GROUP_COLORS[colorIdx % GROUP_COLORS.length],
      });
      colorIdx++;
    } catch (e) {
      console.warn("Failed to group tabs", group, e);
    }
  }
}

// ---------- Cleanup suggestions ----------

async function computeSuggestions(idleMinutes = 30) {
  const tabs = await chrome.tabs.query({});
  const meta = await getTabMeta();
  const now = Date.now();
  const suggestions = [];

  // Idle tabs
  for (const tab of tabs) {
    if (tab.pinned || tab.audible) continue;
    const m = meta[tab.id];
    const lastFocused = m ? m.lastFocusedAt : now;
    const idleMs = now - lastFocused;
    if (!tab.active && idleMs > idleMinutes * 60 * 1000) {
      suggestions.push({
        tabId: tab.id,
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl,
        reason: `Idle for ${Math.round(idleMs / 60000)} min`,
        type: "idle",
      });
    }
  }

  // Duplicate tabs (same normalized URL)
  const seen = new Map();
  for (const tab of tabs) {
    const key = (tab.url || "").split("#")[0].replace(/\/$/, "");
    if (seen.has(key)) {
      const original = seen.get(key);
      if (!suggestions.find((s) => s.tabId === tab.id)) {
        suggestions.push({
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
          favIconUrl: tab.favIconUrl,
          reason: `Duplicate of "${original.title}"`,
          type: "duplicate",
        });
      }
    } else {
      seen.set(key, tab);
    }
  }

  return suggestions;
}

// ---------- Sessions ----------

async function saveSession(name) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const groupIds = [...new Set(tabs.map((t) => t.groupId).filter((id) => id !== -1))];
  const groupInfo = {};
  for (const gid of groupIds) {
    try {
      const g = await chrome.tabGroups.get(gid);
      groupInfo[gid] = { name: g.title || "Group", color: g.color };
    } catch (e) {}
  }

  const groups = {};
  const ungrouped = [];
  for (const tab of tabs) {
    const entry = { title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl };
    if (tab.groupId !== -1 && groupInfo[tab.groupId]) {
      const key = tab.groupId;
      if (!groups[key]) groups[key] = { name: groupInfo[key].name, color: groupInfo[key].color, tabs: [] };
      groups[key].tabs.push(entry);
    } else {
      ungrouped.push(entry);
    }
  }

  const sessionGroups = Object.values(groups);
  if (ungrouped.length) sessionGroups.push({ name: "Ungrouped", color: "grey", tabs: ungrouped });

  const { sessions } = await chrome.storage.local.get("sessions");
  const list = sessions || [];
  const session = {
    id: `session_${Date.now()}`,
    name: name || `Session – ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    groups: sessionGroups,
    tabCount: tabs.length,
  };
  list.unshift(session);
  await chrome.storage.local.set({ sessions: list });
  return session;
}

async function listSessions() {
  const { sessions } = await chrome.storage.local.get("sessions");
  return sessions || [];
}

async function deleteSession(id) {
  const { sessions } = await chrome.storage.local.get("sessions");
  const list = (sessions || []).filter((s) => s.id !== id);
  await chrome.storage.local.set({ sessions: list });
}

async function restoreSession(id) {
  const { sessions } = await chrome.storage.local.get("sessions");
  const session = (sessions || []).find((s) => s.id === id);
  if (!session) return;

  const win = await chrome.windows.create({});
  for (const group of session.groups) {
    const createdTabIds = [];
    for (const t of group.tabs) {
      const newTab = await chrome.tabs.create({ url: t.url, windowId: win.id, active: false });
      createdTabIds.push(newTab.id);
    }
    if (group.name !== "Ungrouped" && createdTabIds.length) {
      const groupId = await chrome.tabs.group({ tabIds: createdTabIds, createProperties: { windowId: win.id } });
      await chrome.tabGroups.update(groupId, { title: group.name, color: group.color || "blue" });
    }
  }
}

// ---------- Message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_TABS": {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const meta = await getTabMeta();
          sendResponse({ ok: true, tabs, meta });
          break;
        }
        case "RUN_CLUSTERING": {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const { settings } = await chrome.storage.local.get("settings");
          let groups;
          let usedLLM = false;
          if (settings && settings.useLLM && settings.apiKey) {
            try {
              groups = await llmCluster(tabs, settings);
              usedLLM = true;
            } catch (e) {
              console.warn("LLM clustering failed, falling back to local clustering:", e);
              groups = localCluster(tabs);
            }
          } else {
            groups = localCluster(tabs);
          }
          await applyGroups(groups, tabs[0] ? tabs[0].windowId : undefined);
          sendResponse({ ok: true, groups, usedLLM });
          break;
        }
        case "GET_SUGGESTIONS": {
          const suggestions = await computeSuggestions(msg.idleMinutes || 30);
          sendResponse({ ok: true, suggestions });
          break;
        }
        case "CLOSE_TABS": {
          await chrome.tabs.remove(msg.tabIds);
          sendResponse({ ok: true });
          break;
        }
        case "SAVE_SESSION": {
          const session = await saveSession(msg.name);
          sendResponse({ ok: true, session });
          break;
        }
        case "LIST_SESSIONS": {
          const sessions = await listSessions();
          sendResponse({ ok: true, sessions });
          break;
        }
        case "DELETE_SESSION": {
          await deleteSession(msg.id);
          sendResponse({ ok: true });
          break;
        }
        case "RESTORE_SESSION": {
          await restoreSession(msg.id);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (err) {
      console.error("Background error:", err);
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // keep the message channel open for the async response
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});
