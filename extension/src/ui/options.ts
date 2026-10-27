import {
  endpointIdFor,
  loadSettings,
  relayHealthUrl,
  saveSettings,
} from "../lib/settings";
import {
  LAST_PUSHED_HASH_KEY,
  LAST_SEQ_KEY,
  PREVIEW_KEY,
} from "../lib/status";

function input(id: string): HTMLInputElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ? element : null;
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

async function render(): Promise<void> {
  const settings = await loadSettings();
  const relayUrl = input("relay-url");
  const token = input("token");
  const profileLabel = input("profile-label");
  const browser = document.getElementById("browser");

  if (relayUrl) relayUrl.value = settings.relayUrl;
  if (token) token.value = settings.token;
  if (profileLabel) profileLabel.value = settings.profileLabel;
  if (browser instanceof HTMLSelectElement) browser.value = settings.browser;

  setText("endpoint-preview", endpointIdFor(settings));
}

async function testConnection(): Promise<void> {
  const result = document.getElementById("result");
  const relayUrl = input("relay-url")?.value.trim() ?? "";
  const healthUrl = relayHealthUrl(relayUrl);

  if (result) {
    result.textContent = `正在检查 ${healthUrl} …`;
    result.className = "";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(healthUrl, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { seq?: number; endpointsOnline?: number };
    if (result) {
      result.textContent = `连接正常：seq=${body.seq ?? "?"}，在线端点=${body.endpointsOnline ?? "?"}`;
      result.className = "ok";
    }
  } catch (error) {
    if (result) {
      result.textContent = `连接失败：${error instanceof Error ? error.message : String(error)}`;
      result.className = "bad";
    }
  } finally {
    clearTimeout(timer);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  void render();

  const form = document.getElementById("settings-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const result = document.getElementById("result");
      const relayUrl = input("relay-url")?.value.trim() ?? "";
      const token = input("token")?.value.trim() ?? "";
      const profileLabel = input("profile-label")?.value.trim() || "default";
      const browserElement = document.getElementById("browser");
      const browser = browserElement instanceof HTMLSelectElement ? browserElement.value : "chrome";

      if (!/^wss?:\/\//.test(relayUrl)) {
        if (result) {
          result.textContent = "中继地址必须以 ws:// 或 wss:// 开头";
          result.className = "bad";
        }
        return;
      }
      if (token.length === 0) {
        if (result) {
          result.textContent = "令牌不能为空，请从中继启动日志或 relay/data/token.txt 复制";
          result.className = "bad";
        }
        return;
      }

      const current = await loadSettings();
      const nextBrowser = browser === "ego" ? "ego" : "chrome";
      const identityChanged =
        current.browser !== nextBrowser || current.profileLabel !== profileLabel;

      const saved = await saveSettings({
        relayUrl,
        token,
        profileLabel,
        browser: nextBrowser,
        ...(identityChanged ? { paired: false } : {}),
      });

      if (identityChanged) {
        await chrome.storage.local.remove([LAST_SEQ_KEY, LAST_PUSHED_HASH_KEY, PREVIEW_KEY]);
      }

      setText("endpoint-preview", endpointIdFor(saved));
      if (result) {
        result.textContent = identityChanged
          ? "已保存。端点身份已变化，需要重新完成首次配对。"
          : "已保存。扩展会重新连接中继。";
        result.className = "ok";
      }
      await chrome.runtime.sendMessage({ type: "reconnect" });
    })();
  });

  document.getElementById("test-connection")?.addEventListener("click", () => {
    void testConnection();
  });

  document.getElementById("reset-sync")?.addEventListener("click", () => {
    const confirmed = window.confirm(
      "重置会清除本地的同步映射、基线和配对状态，需要重新完成首次配对。书签本身不会被删除。继续？",
    );
    if (!confirmed) return;

    void (async () => {
      const result = document.getElementById("result");
      const response = (await chrome.runtime.sendMessage({ type: "reset-sync" })) as
        | { ok?: boolean; error?: string }
        | undefined;
      if (result) {
        result.textContent = response?.ok
          ? "已重置，请在弹窗中重新完成配对。"
          : `重置失败：${response?.error ?? "未知错误"}`;
        result.className = response?.ok ? "ok" : "bad";
      }
      await render();
    })();
  });
});
