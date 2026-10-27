import { readTree } from "../background/bookmarks-adapter";
import { endpointIdFor, loadSettings } from "../lib/settings";
import {
  CONFLICTS_KEY,
  PREVIEW_KEY,
  STATUS_KEY,
  type StoredConflict,
  type SyncPreview,
  type SyncStatus,
} from "../lib/status";

function conflictLabel(kind: string): string {
  switch (kind) {
    case "delete_vs_edit":
      return "删除与修改冲突";
    case "move_cycle":
      return "移动成环";
    case "missing_parent":
      return "父文件夹缺失";
    case "duplicate_sync_id":
      return "重复身份";
    case "invalid_position":
      return "位置无效";
    default:
      return kind;
  }
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function statusLabel(status: SyncStatus | undefined, paused: boolean): string {
  if (paused) return "已暂停";
  switch (status?.state) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中…";
    case "preview":
      return "待确认配对";
    case "error":
      return status.message ? `错误：${status.message}` : "错误";
    default:
      return status?.message ?? "未连接";
  }
}

async function render(): Promise<void> {
  const settings = await loadSettings();
  const stored = await chrome.storage.local.get([
    STATUS_KEY,
    PREVIEW_KEY,
    CONFLICTS_KEY,
  ]);
  const status = stored[STATUS_KEY] as SyncStatus | undefined;
  const preview = stored[PREVIEW_KEY] as SyncPreview | undefined;
  const conflicts = Array.isArray(stored[CONFLICTS_KEY])
    ? (stored[CONFLICTS_KEY] as StoredConflict[])
    : [];

  setText("status", statusLabel(status, settings.paused));
  setText("endpoint", endpointIdFor(settings));
  setText(
    "last-sync",
    status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "—",
  );
  setText("pending", String(status?.pending ?? 0));
  setText("conflicts", String(conflicts.length));

  const toggle = document.getElementById("toggle-pause");
  if (toggle instanceof HTMLButtonElement) {
    toggle.textContent = settings.paused ? "恢复同步" : "暂停同步";
  }

  const statusElement = document.getElementById("status");
  if (statusElement) {
    statusElement.dataset.state = settings.paused ? "paused" : (status?.state ?? "disconnected");
  }

  const conflictsSection = document.getElementById("conflicts-section");
  if (conflictsSection instanceof HTMLElement) conflictsSection.hidden = conflicts.length === 0;
  const conflictList = document.getElementById("conflict-list");
  if (conflictList) {
    conflictList.replaceChildren(
      ...conflicts.slice(0, 5).map((conflict) => {
        const item = document.createElement("li");
        item.textContent = `${conflictLabel(conflict.kind)}：${conflict.detail}`;
        return item;
      }),
    );
  }

  const section = document.getElementById("preview-section");
  if (section instanceof HTMLElement) section.hidden = !preview;

  if (preview) {
    setText(
      "preview-counts",
      `新增 ${preview.counts.added} · 更新 ${preview.counts.updated} · 删除 ${preview.counts.deleted}`,
    );
    setText(
      "preview-conflicts",
      preview.counts.conflicts > 0 ? `冲突 ${preview.counts.conflicts}` : "无冲突",
    );
  }
}

async function exportBookmarks(): Promise<void> {
  const tree = await readTree();
  const payload = {
    exportedAt: new Date().toISOString(),
    roots: tree.roots,
    nodes: tree.nodes,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `bookmarks-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

document.addEventListener("DOMContentLoaded", () => {
  void render();

  document.getElementById("sync-now")?.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "sync-now" });
  });

  document.getElementById("toggle-pause")?.addEventListener("click", async () => {
    const settings = await loadSettings();
    await chrome.runtime.sendMessage({ type: "set-paused", paused: !settings.paused });
    await render();
  });

  document.getElementById("open-options")?.addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });

  document.getElementById("export-bookmarks")?.addEventListener("click", () => {
    void exportBookmarks();
  });

  document.getElementById("confirm-pairing")?.addEventListener("click", () => {
    void (async () => {
      const button = document.getElementById("confirm-pairing");
      if (button instanceof HTMLButtonElement) button.disabled = true;
      const response = (await chrome.runtime.sendMessage({
        type: "confirm-pairing",
      })) as { ok?: boolean; error?: string } | undefined;
      setText(
        "preview-result",
        response?.ok ? "配对完成，正在同步…" : `确认失败：${response?.error ?? "未知错误"}`,
      );
      if (button instanceof HTMLButtonElement) button.disabled = false;
      await render();
    })();
  });
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === "local") void render();
});
