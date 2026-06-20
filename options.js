async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) return;
  document.getElementById("useLLM").checked = !!settings.useLLM;
  document.getElementById("apiKey").value = settings.apiKey || "";
  document.getElementById("model").value = settings.model || "claude-haiku-4-5-20251001";
}

document.getElementById("saveBtn").addEventListener("click", async () => {
  const settings = {
    useLLM: document.getElementById("useLLM").checked,
    apiKey: document.getElementById("apiKey").value.trim(),
    model: document.getElementById("model").value,
  };
  await chrome.storage.local.set({ settings });
  const msg = document.getElementById("savedMsg");
  msg.style.display = "inline";
  setTimeout(() => (msg.style.display = "none"), 2000);
});

loadSettings();
