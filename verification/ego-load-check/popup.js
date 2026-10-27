function setFlag(id, value) {
  const el = document.getElementById(id);
  el.textContent = value ? "可用" : "不可用";
  el.className = value ? "ok" : "bad";
}

function render(result) {
  if (!result) {
    document.getElementById("error").textContent = "尚无检查结果，点击下方按钮重试。";
    return;
  }
  setFlag("bookmarks", result.hasBookmarksApi);
  setFlag("storage", result.hasStorageApi);
  setFlag("alarms", result.hasAlarmsApi);
  document.getElementById("roots").textContent = result.rootIds.length
    ? result.rootIds.join(", ")
    : "—";
  document.getElementById("count").textContent = String(result.nodeCount);
  document.getElementById("at").textContent = result.at;
  document.getElementById("error").textContent = result.error
    ? "错误：" + result.error
    : "";
}

async function run() {
  const response = await chrome.runtime.sendMessage({ type: "run-check" });
  render(response);
}

document.addEventListener("DOMContentLoaded", async () => {
  const stored = await chrome.storage.local.get("egoLoadCheck");
  render(stored.egoLoadCheck);
  document.getElementById("again").addEventListener("click", run);
});
