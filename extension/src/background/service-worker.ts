import { subscribeBookmarkEvents } from "./bookmarks-adapter";
import type { ExpectedNodeState } from "./loop-guard";
import { SyncClient } from "./sync-client";
import { loadSettings } from "../lib/settings";
import { STATUS_KEY } from "../lib/status";

const COMPENSATE_ALARM = "bookmark-sync-compensate";
const SYNC_DEBOUNCE_MS = 500;
// Longer than LoopGuard's 1.5s batch window, so a user edit made during a
// remote apply is still picked up by the reconciliation pass.
const RECONCILE_DELAY_MS = 1_800;

const client = new SyncClient({
  onStatus: (status) => {
    void chrome.storage.local.set({ [STATUS_KEY]: status });
  },
  onServerMessage: () => {
    // T023 applies ops/snapshot messages and acknowledges them.
  },
});

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSync(reason: string, delayMs = SYNC_DEBOUNCE_MS): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    client.requestSync(reason);
  }, delayMs);
}

function handleBookmarkEvent(observed: ExpectedNodeState, reason: string): void {
  if (client.shouldIgnoreBookmarkEvent(observed)) {
    scheduleSync(`reconcile-${reason}`, RECONCILE_DELAY_MS);
    return;
  }
  scheduleSync(reason);
}

function ensureAlarm(): void {
  chrome.alarms.create(COMPENSATE_ALARM, { periodInMinutes: 1 });
}

function kindOf(node: chrome.bookmarks.BookmarkTreeNode): "bookmark" | "folder" {
  return typeof node.url === "string" ? "bookmark" : "folder";
}

subscribeBookmarkEvents({
  onCreated: (id, node) => {
    handleBookmarkEvent(
      {
        localId: id,
        kind: kindOf(node),
        parentLocalId: node.parentId ?? null,
        title: node.title ?? "",
        url: node.url ?? null,
      },
      "created",
    );
  },
  onRemoved: (id) => {
    handleBookmarkEvent({ localId: id }, "removed");
  },
  onChanged: (id, info) => {
    handleBookmarkEvent({ localId: id, title: info.title, url: info.url }, "changed");
  },
  onMoved: (id, info) => {
    handleBookmarkEvent({ localId: id, parentLocalId: info.parentId }, "moved");
  },
  onChildrenReordered: (id) => {
    handleBookmarkEvent({ localId: id }, "reordered");
  },
  onImportEnded: () => scheduleSync("import-ended"),
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== COMPENSATE_ALARM) return;
  void client.ensureConnected();
  scheduleSync("alarm");
});

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  void (async () => {
    const settings = await loadSettings();
    if (!settings.token) {
      chrome.runtime.openOptionsPage();
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  void client.ensureConnected();
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const type = (message as { type?: unknown }).type;

  if (type === "sync-now") {
    scheduleSync("manual");
    sendResponse({ ok: true });
    return false;
  }

  if (type === "set-paused") {
    const paused = Boolean((message as { paused?: unknown }).paused);
    void client
      .setPaused(paused)
      .then(() => sendResponse({ ok: true, paused }))
      .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (type === "confirm-pairing") {
    void client
      .confirmPairing()
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (type === "reconnect") {
    client.stop();
    void client
      .start()
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (type === "reset-sync") {
    void client
      .resetSyncState()
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (type === "get-status") {
    void (async () => {
      const [settings, stored] = await Promise.all([
        loadSettings(),
        chrome.storage.local.get(STATUS_KEY),
      ]);
      sendResponse({ settings, status: stored[STATUS_KEY] ?? null });
    })();
    return true;
  }

  return false;
});

ensureAlarm();
void client.start();
