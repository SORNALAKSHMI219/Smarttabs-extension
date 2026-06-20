const GROUP_COLOR_HEX = {
  blue: "#5B8DEF", red: "#EF5350", yellow: "#F5C84C", green: "#3DD598",
  pink: "#F472B6", purple: "#A78BFA", cyan: "#2DD4BF", orange: "#F5A524", grey: "#6B7894",
};

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function favicon(url, fallback) {
  return url || fallback || "";
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ---------- Tab navigation between views ----------

document.querySelectorAll(".tabbar-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabbar-item").forEach((b) => b.classList.remove("is-active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active"));
    btn.classList.add("is-active");
    document.getElementById(`view-${btn.dataset.view}`).classList.add("is-active");
    if (btn.dataset.view === "cleanup") loadCleanup();
    if (btn.dataset.view === "sessions") loadSessions();
    if (btn.dataset.view === "groups") loadGroups();
  });
});

document.getElementById("settingsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// ---------- Groups view ----------

async function loadGroups() {
  const { tabs } = await send({ type: "GET_TABS" });
  const groupsList = document.getElementById("groupsList");
  groupsList.innerHTML = "";

  const byGroup = {};
  const ungrouped = [];
  for (const tab of tabs) {
    if (tab.groupId && tab.groupId !== -1) {
      if (!byGroup[tab.groupId]) byGroup[tab.groupId] = [];
      byGroup[tab.groupId].push(tab);
    } else {
      ungrouped.push(tab);
    }
  }

  const groupIds = Object.keys(byGroup);
  if (groupIds.length === 0 && ungrouped.length === 0) {
    groupsList.innerHTML = `<div class="empty-state">No tabs open in this window.</div>`;
    return;
  }
  if (groupIds.length === 0) {
    groupsList.innerHTML = `<div class="empty-state">Tabs aren't grouped yet. Hit "Group my tabs" above.</div>`;
  }

  for (const gid of groupIds) {
    let title = "Group", color = "blue";
    try {
      const g = await chrome.tabGroups.get(Number(gid));
      title = g.title || "Group";
      color = g.color || "blue";
    } catch (e) {}
    groupsList.appendChild(renderGroupCard(title, color, byGroup[gid]));
  }

  if (ungrouped.length) {
    groupsList.appendChild(renderGroupCard("Ungrouped", "grey", ungrouped));
  }
}

function renderGroupCard(name, color, tabs) {
  const card = document.createElement("div");
  card.className = "group-card";

  const head = document.createElement("div");
  head.className = "group-head";
  head.innerHTML = `
    <span class="group-color-bar" style="background:${GROUP_COLOR_HEX[color] || "#6B7894"}"></span>
    <span class="group-name">${escapeHtml(name)}</span>
    <span class="group-count">${tabs.length} tab${tabs.length === 1 ? "" : "s"}</span>
  `;
  card.appendChild(head);

  const body = document.createElement("div");
  body.style.display = "none";
  tabs.forEach((tab) => {
    const row = document.createElement("div");
    row.className = "tab-row";
    row.innerHTML = `
      <img class="tab-favicon" src="${favicon(tab.favIconUrl)}" onerror="this.style.visibility='hidden'" />
      <span class="tab-title">${escapeHtml(tab.title || tab.url)}</span>
    `;
    row.addEventListener("click", () => {
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
    });
    body.appendChild(row);
  });
  card.appendChild(body);

  head.addEventListener("click", () => {
    body.style.display = body.style.display === "none" ? "block" : "none";
  });

  return card;
}

document.getElementById("clusterBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("groupsStatus");
  const btn = document.getElementById("clusterBtn");
  btn.disabled = true;
  statusEl.textContent = "Grouping...";
  const result = await send({ type: "RUN_CLUSTERING" });
  btn.disabled = false;
  if (result && result.ok) {
    statusEl.textContent = result.usedLLM ? "Grouped using AI" : "Grouped (offline mode)";
    loadGroups();
  } else {
    statusEl.textContent = "Something went wrong.";
  }
  setTimeout(() => (statusEl.textContent = ""), 3000);
});

// ---------- Cleanup view ----------

let currentSuggestions = [];
const selectedToClose = new Set();

async function loadCleanup() {
  const result = await send({ type: "GET_SUGGESTIONS", idleMinutes: 30 });
  currentSuggestions = (result && result.suggestions) || [];
  selectedToClose.clear();
  renderCleanup();
}

function renderCleanup() {
  const list = document.getElementById("cleanupList");
  list.innerHTML = "";

  if (currentSuggestions.length === 0) {
    list.innerHTML = `<div class="empty-state">Nothing to clean up right now. Tidy browser, tidy mind.</div>`;
  }

  currentSuggestions.forEach((s) => {
    const row = document.createElement("div");
    row.className = "cleanup-row";
    row.innerHTML = `
      <input type="checkbox" data-id="${s.tabId}" />
      <img class="tab-favicon" src="${favicon(s.favIconUrl)}" onerror="this.style.visibility='hidden'" />
      <div class="cleanup-info">
        <div class="cleanup-title">${escapeHtml(s.title || s.url)}</div>
        <div class="cleanup-reason ${s.type}">${escapeHtml(s.reason)}</div>
      </div>
    `;
    const checkbox = row.querySelector("input");
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedToClose.add(s.tabId);
      else selectedToClose.delete(s.tabId);
      updateCloseButton();
    });
    list.appendChild(row);
  });

  updateCloseButton();
}

function updateCloseButton() {
  const btn = document.getElementById("closeSelectedBtn");
  btn.textContent = `Close selected (${selectedToClose.size})`;
  btn.disabled = selectedToClose.size === 0;
}

document.getElementById("refreshSuggestionsBtn").addEventListener("click", loadCleanup);

document.getElementById("closeSelectedBtn").addEventListener("click", async () => {
  await send({ type: "CLOSE_TABS", tabIds: [...selectedToClose] });
  loadCleanup();
});

// ---------- Sessions view ----------

async function loadSessions() {
  const result = await send({ type: "LIST_SESSIONS" });
  const sessions = (result && result.sessions) || [];
  const list = document.getElementById("sessionsList");
  list.innerHTML = "";

  if (sessions.length === 0) {
    list.innerHTML = `<div class="empty-state">No saved sessions yet.</div>`;
    return;
  }

  sessions.forEach((s) => {
    const card = document.createElement("div");
    card.className = "session-card";
    card.innerHTML = `
      <div class="session-top">
        <span class="session-name">${escapeHtml(s.name)}</span>
      </div>
      <div class="session-meta">${s.tabCount} tabs · ${s.groups.length} groups · ${timeAgo(s.createdAt)}</div>
      <div class="session-actions">
        <button class="btn btn-primary btn-small" data-action="restore">Restore</button>
        <button class="btn btn-danger btn-small" data-action="delete">Delete</button>
      </div>
    `;
    card.querySelector('[data-action="restore"]').addEventListener("click", async () => {
      await send({ type: "RESTORE_SESSION", id: s.id });
    });
    card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      await send({ type: "DELETE_SESSION", id: s.id });
      loadSessions();
    });
    list.appendChild(card);
  });
}

document.getElementById("saveSessionBtn").addEventListener("click", async () => {
  const input = document.getElementById("sessionNameInput");
  await send({ type: "SAVE_SESSION", name: input.value.trim() });
  input.value = "";
  loadSessions();
});

// ---------- Utils ----------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ---------- Init ----------

loadGroups();
