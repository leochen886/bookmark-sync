import {
  ROOT_SYNC_IDS,
  bind,
  bindingsFromJSON,
  createBindings,
  resolveLocalId,
  resolveSyncId,
  snapshotHash,
  unbindLocal,
  type Change,
  type SnapshotNode,
  type SyncBindings,
} from "@bookmark-sync/core";
import {
  PROTOCOL_VERSION,
  safeParseServerMessage,
  type ClientMessage,
  type Conflict,
  type OpsMessage,
  type PushMessage,
  type ServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@bookmark-sync/core/protocol";
import {
  createBookmark,
  createFolder,
  findLocalContentMatch,
  getNode,
  getSubtree,
  moveNode,
  readTree,
  removeNode,
  updateNode,
  type LocalTree,
} from "./bookmarks-adapter";
import { LoopGuard, type ExpectedNodeState } from "./loop-guard";
import {
  endpointIdFor,
  loadSettings,
  saveSettings,
  type ExtensionSettings,
} from "../lib/settings";
import {
  BINDINGS_KEY,
  CONFLICTS_KEY,
  LAST_PUSHED_HASH_KEY,
  LAST_SEQ_KEY,
  PREVIEW_KEY,
  type StoredConflict,
  type SyncPreview,
  type SyncStatus,
} from "../lib/status";

const CLIENT_VERSION = "0.1.0";
const PING_INTERVAL_MS = 25_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const WATCHDOG_TIMEOUT_MS = 45_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

interface PendingRequest {
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SyncClientOptions {
  onStatus?: (status: SyncStatus) => void;
  onWelcome?: (message: WelcomeMessage) => void;
  onServerMessage?: (message: ServerMessage) => void;
  onSyncRequested?: (reason: string) => void;
}

function previewTotal(preview: SyncPreview): number {
  return preview.counts.added + preview.counts.updated + preview.counts.deleted;
}

export class SyncClient {
  private socket: WebSocket | null = null;
  private settings: ExtensionSettings | null = null;
  private stopped = true;
  private reconnectDelay = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastReceivedAt = 0;
  private lastSeq = 0;
  private status: SyncStatus = { state: "disconnected", at: Date.now() };

  private bindings: SyncBindings = createBindings();
  private stateLoaded = false;
  private lastPushedHash: string | null = null;
  private preview: SyncPreview | null = null;
  private needsResync = false;

  private syncing = false;
  private syncQueued = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly loopGuard = new LoopGuard();
  private readonly unsolicitedQueue: OpsMessage[] = [];

  constructor(private readonly options: SyncClientOptions = {}) {}

  get currentStatus(): SyncStatus {
    return this.status;
  }

  get currentPreview(): SyncPreview | null {
    return this.preview;
  }

  async start(): Promise<void> {
    this.settings = await loadSettings();
    await this.ensureStateLoaded();

    if (this.settings.paused) {
      this.stopped = true;
      this.updateStatus({ state: "disconnected", message: "同步已暂停" });
      return;
    }
    if (!this.stopped && this.socket) return;

    this.stopped = false;
    this.lastSeq = await this.readLastSeq();
    if (!this.settings.token) {
      this.updateStatus({ state: "error", message: "未配置中继令牌，请打开设置" });
      return;
    }
    this.connect();
  }

  async ensureConnected(): Promise<void> {
    if (this.stopped) {
      await this.start();
      return;
    }
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;

    this.settings = await loadSettings();
    if (this.settings.paused) return;
    if (!this.settings.token) {
      this.updateStatus({ state: "error", message: "未配置中继令牌，请打开设置" });
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("连接已关闭"));
    }
    this.pending.clear();

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, "client stopped");
      } catch {
        // ignore
      }
    }
    this.updateStatus({ state: "disconnected" });
  }

  async setPaused(paused: boolean): Promise<void> {
    this.settings = await saveSettings({ paused });
    if (paused) {
      this.stop();
      this.updateStatus({ state: "disconnected", message: "同步已暂停" });
      return;
    }
    this.stopped = false;
    this.reconnectDelay = 1_000;
    await this.start();
  }

  shouldIgnoreBookmarkEvent(observed: ExpectedNodeState): boolean {
    const ignored = this.loopGuard.consume(observed);
    this.loopGuard.prune();
    return ignored;
  }

  requestSync(reason: string): void {
    this.options.onSyncRequested?.(reason);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateStatus({ pending: Math.max(1, this.status.pending ?? 0) });
    }
    if (this.stopped) {
      void this.start()
        .then(() => this.runSync(reason))
        .catch(() => undefined);
      return;
    }
    void this.runSync(reason);
  }

  /** Clears local sync state and forces a fresh pairing preview. */
  async resetSyncState(): Promise<void> {
    this.stop();
    this.bindings = createBindings();
    this.preview = null;
    this.lastPushedHash = null;
    this.lastSeq = 0;
    this.needsResync = false;
    this.stateLoaded = false;

    await chrome.storage.local.remove([
      BINDINGS_KEY,
      LAST_SEQ_KEY,
      LAST_PUSHED_HASH_KEY,
      PREVIEW_KEY,
      CONFLICTS_KEY,
    ]);

    this.settings = await saveSettings({ paired: false });
    this.updateStatus({ state: "disconnected", pending: 0, conflicts: 0, message: "已重置，请重新配对" });
    await this.start();
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  async acknowledge(seq: number): Promise<void> {
    this.lastSeq = Math.max(this.lastSeq, seq);
    await this.writeLastSeq(this.lastSeq);
    this.sendRaw({ v: PROTOCOL_VERSION, type: "ack", ts: Date.now(), seq: this.lastSeq });
  }

  async confirmPairing(): Promise<void> {
    await this.ensureStateLoaded();
    const preview = this.preview ?? (await this.readPreview());
    if (!preview) throw new Error("没有待确认的配对预览");

    const requestId = crypto.randomUUID();
    const response = await this.request({
      v: PROTOCOL_VERSION,
      type: "commit",
      requestId,
      ts: Date.now(),
      previewRequestId: preview.requestId,
      snapshotHash: preview.snapshotHash,
    });
    if (response.type !== "push-result") {
      throw new Error(`配对失败：收到 ${response.type}`);
    }

    await this.applyBindings(response.bindings);
    await this.recordConflicts(response.conflicts);
    this.settings = await saveSettings({ paired: true });
    this.preview = null;
    await chrome.storage.local.remove(PREVIEW_KEY);

    this.lastPushedHash = preview.snapshotHash;
    await chrome.storage.local.set({ [LAST_PUSHED_HASH_KEY]: preview.snapshotHash });

    await this.pullAndApply();
    this.updateStatus({
      state: "connected",
      lastSyncAt: Date.now(),
      pending: 0,
      conflicts: response.counts.conflicts,
    });
  }

  private async runSync(reason: string): Promise<void> {
    void reason;
    if (this.stopped) return;
    if (this.syncing) {
      this.syncQueued = true;
      return;
    }

    this.syncing = true;
    try {
      await this.ensureStateLoaded();
      this.settings = await loadSettings();
      if (this.settings.paused) return;

      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        await this.ensureConnected();
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
          if (this.status.state !== "preview") this.updateStatus({ state: "connecting" });
          return;
        }
      }

      if (this.needsResync) {
        await this.resyncAndApply();
      }

      if (!this.settings.paired) {
        await this.runPreview();
        return;
      }

      await this.pushAndPull();
      this.updateStatus({ state: "connected", lastSyncAt: Date.now(), pending: 0 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus({
        state: this.status.state === "preview" ? "preview" : "error",
        message,
      });
    } finally {
      this.syncing = false;
      if (this.syncQueued) {
        this.syncQueued = false;
        void this.runSync("queued");
      } else if (this.unsolicitedQueue.length > 0) {
        void this.flushOps();
      }
    }
  }

  private async runPreview(): Promise<void> {
    const tree = await readTree();
    const nodes = this.enrich(tree);
    const hash = snapshotHash(tree.roots, nodes);

    if (this.preview && this.preview.snapshotHash === hash) {
      this.updateStatus({
        state: "preview",
        pending: previewTotal(this.preview),
        conflicts: this.preview.conflicts.length,
      });
      return;
    }

    const requestId = crypto.randomUUID();
    const response = await this.request({
      v: PROTOCOL_VERSION,
      type: "push",
      requestId,
      ts: Date.now(),
      baseSeq: this.lastSeq,
      snapshotHash: hash,
      dryRun: true,
      snapshot: { roots: tree.roots, nodes },
    });
    if (response.type !== "push-result") {
      throw new Error(`预演失败：收到 ${response.type}`);
    }

    const preview: SyncPreview = {
      requestId,
      snapshotHash: hash,
      counts: response.counts,
      conflicts: response.conflicts,
      at: Date.now(),
    };
    this.preview = preview;
    await chrome.storage.local.set({ [PREVIEW_KEY]: preview });
    this.updateStatus({
      state: "preview",
      pending: previewTotal(preview),
      conflicts: preview.conflicts.length,
    });
  }

  private async pushAndPull(): Promise<void> {
    const tree = await readTree();
    await this.pruneBindings(tree);
    const nodes = this.enrich(tree);
    const hash = snapshotHash(tree.roots, nodes);

    if (this.lastPushedHash !== hash) {
      const requestId = crypto.randomUUID();
      const message: PushMessage = {
        v: PROTOCOL_VERSION,
        type: "push",
        requestId,
        ts: Date.now(),
        baseSeq: this.lastSeq,
        snapshotHash: hash,
        snapshot: { roots: tree.roots, nodes },
      };
      const response = await this.request(message);
      if (response.type !== "push-result") {
        throw new Error(`推送失败：收到 ${response.type}`);
      }
      await this.applyBindings(response.bindings);
      await this.recordConflicts(response.conflicts);
      this.lastPushedHash = hash;
      await chrome.storage.local.set({ [LAST_PUSHED_HASH_KEY]: hash });
      if (response.applied) this.updateStatus({ lastSyncAt: Date.now() });
    }

    await this.pullAndApply();
  }

  private async pullAndApply(): Promise<void> {
    for (;;) {
      const requestId = crypto.randomUUID();
      let response: ServerMessage;
      try {
        response = await this.request({
          v: PROTOCOL_VERSION,
          type: "pull",
          requestId,
          ts: Date.now(),
          sinceSeq: this.lastSeq,
          limit: 2000,
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("SEQ_GAP")) {
          await this.resyncAndApply();
          return;
        }
        throw error;
      }

      if (response.type === "snapshot") {
        await this.applySnapshot(response);
        await this.acknowledge(response.seq);
        return;
      }
      if (response.type !== "ops") {
        throw new Error(`拉取失败：收到 ${response.type}`);
      }

      if (response.changes.length > 0) await this.applyChanges(response.changes);
      await this.acknowledge(response.seq);
      if (!response.hasMore) return;
    }
  }

  private async resyncAndApply(): Promise<void> {
    const requestId = crypto.randomUUID();
    const response = await this.request({
      v: PROTOCOL_VERSION,
      type: "resync",
      requestId,
      ts: Date.now(),
    });
    if (response.type !== "snapshot") {
      throw new Error(`重同步失败：收到 ${response.type}`);
    }
    await this.applySnapshot(response);
    await this.acknowledge(response.seq);
    this.needsResync = false;
  }

  private async applyChanges(changes: Change[]): Promise<void> {
    if (changes.length === 0) return;
    const roots = await this.rootLocalIds();
    this.loopGuard.beginBatch();

    const ordered = [...changes].sort((left, right) => left.seq - right.seq);
    let pending = ordered;

    for (let pass = 0; pass < 4 && pending.length > 0; pass += 1) {
      const next: Change[] = [];
      for (const change of pending) {
        const applied = await this.applyChange(change, roots);
        if (!applied) next.push(change);
      }
      if (next.length === pending.length) {
        pending = next;
        break;
      }
      pending = next;
    }

    await this.saveBindings();
    if (pending.length > 0) {
      throw new Error(`${pending.length} 个远端变更无法应用（父节点缺失）`);
    }
  }

  private async applyChange(change: Change, roots: Map<string, string>): Promise<boolean> {
    switch (change.type) {
      case "add":
      case "undelete": {
        const kind = change.payload.kind ?? "bookmark";
        return this.ensureCanonicalNode({
          syncId: change.syncId,
          kind,
          title: change.payload.title ?? "",
          url: change.payload.url ?? null,
          parentSyncId: change.payload.parentSyncId ?? null,
          position: change.payload.position ?? 0,
          roots,
        });
      }
      case "update": {
        const localId = resolveLocalId(this.bindings, change.syncId);
        if (!localId) return false;
        const node = await getNode(localId);
        if (!node) {
          unbindLocal(this.bindings, localId);
          return false;
        }

        const title = change.payload.title ?? node.title ?? "";
        const currentUrl = typeof node.url === "string" ? node.url : null;
        const hasUrl = change.payload.url !== undefined;
        const nextUrl = hasUrl ? (change.payload.url ?? null) : currentUrl;
        const titleChanged = (node.title ?? "") !== title;
        const urlChanged = hasUrl && currentUrl !== nextUrl;

        if (titleChanged || urlChanged) {
          await updateNode(
            localId,
            hasUrl ? { title, url: nextUrl ?? "" } : { title },
          );
          this.loopGuard.expect({ localId, title, url: nextUrl });
        }
        return true;
      }
      case "delete":
        return this.removeLocalSubtree(change.syncId);
      case "move": {
        const localId = resolveLocalId(this.bindings, change.syncId);
        if (!localId) return false;

        const parentSyncId = change.payload.parentSyncId ?? null;
        if (!parentSyncId) return false;
        const parentLocalId =
          roots.get(parentSyncId) ?? resolveLocalId(this.bindings, parentSyncId);
        if (!parentLocalId) return false;

        const index =
          change.payload.position !== undefined
            ? Math.max(0, Math.trunc(change.payload.position))
            : undefined;

        try {
          await moveNode(localId, parentLocalId, index);
        } catch {
          // The destination may have fewer children than the source; append.
          await moveNode(localId, parentLocalId);
        }
        this.loopGuard.expect({ localId, parentLocalId });
        return true;
      }
      default:
        return true;
    }
  }

  private async applySnapshot(message: SnapshotMessage): Promise<void> {
    const roots = await this.rootLocalIds();
    this.loopGuard.beginBatch();

    for (const node of message.nodes) {
      if (node.deleted) {
        await this.removeLocalSubtree(node.syncId);
      }
    }

    const active = message.nodes.filter((node) => !node.deleted);
    const ordered = this.sortCanonicalNodes(active);

    let pending = ordered;
    for (let pass = 0; pass < 4 && pending.length > 0; pass += 1) {
      const next: typeof pending = [];
      for (const node of pending) {
        const applied = await this.ensureCanonicalNode({
          syncId: node.syncId,
          kind: node.kind,
          title: node.title,
          url: node.url,
          parentSyncId: node.parentSyncId,
          position: node.position,
          roots,
        });
        if (!applied) next.push(node);
      }
      if (next.length === pending.length) {
        pending = next;
        break;
      }
      pending = next;
    }

    await this.saveBindings();
    if (pending.length > 0) {
      throw new Error(`${pending.length} 个节点无法重建（父节点缺失）`);
    }
  }

  private async ensureCanonicalNode(args: {
    syncId: string;
    kind: "bookmark" | "folder";
    title: string;
    url: string | null;
    parentSyncId: string | null;
    position: number;
    roots: Map<string, string>;
  }): Promise<boolean> {
    // Root folders are virtual: bind them, but never rename, move or remove
    // them. Chrome rejects any write to a root ("Can't modify the root
    // bookmark folders"), and their titles differ by browser locale.
    const rootLocalId = args.roots.get(args.syncId);
    if (rootLocalId) {
      bind(this.bindings, rootLocalId, args.syncId);
      return true;
    }

    const existingLocalId = resolveLocalId(this.bindings, args.syncId);
    if (existingLocalId) {
      const node = await getNode(existingLocalId);
      if (!node) {
        unbindLocal(this.bindings, existingLocalId);
      } else {
        const currentTitle = node.title ?? "";
        const currentUrl = typeof node.url === "string" ? node.url : null;
        const nextUrl = args.kind === "bookmark" ? (args.url ?? "") : null;
        const titleChanged = currentTitle !== args.title;
        const urlChanged = args.kind === "bookmark" && currentUrl !== nextUrl;

        if (titleChanged || urlChanged) {
          await updateNode(
            existingLocalId,
            args.kind === "bookmark"
              ? { title: args.title, url: nextUrl ?? "" }
              : { title: args.title },
          );
          this.loopGuard.expect({
            localId: existingLocalId,
            title: args.title,
            url: nextUrl,
          });
        }
        return true;
      }
    }

    const parentLocalId = args.parentSyncId
      ? (args.roots.get(args.parentSyncId) ??
        resolveLocalId(this.bindings, args.parentSyncId))
      : undefined;
    if (!parentLocalId) return false;

    // Adopt an unbound local bookmark/folder with the same content instead of
    // creating a duplicate. This is what keeps a second endpoint (which already
    // had the same bookmarks before pairing) from doubling every entry.
    const existingMatch = await findLocalContentMatch({
      parentLocalId,
      kind: args.kind,
      title: args.title,
      url: args.url,
    });
    if (existingMatch) {
      const existingSyncId = resolveSyncId(this.bindings, existingMatch.id);
      if (!existingSyncId || existingSyncId === args.syncId) {
        bind(this.bindings, existingMatch.id, args.syncId);
        this.loopGuard.expect({
          localId: existingMatch.id,
          kind: args.kind,
          parentLocalId,
          title: args.title,
          url: args.kind === "bookmark" ? (args.url ?? "") : null,
        });
        return true;
      }
    }

    const created =
      args.kind === "folder"
        ? await createFolder({ parentLocalId, title: args.title })
        : await createBookmark({
            parentLocalId,
            title: args.title,
            url: args.url ?? "",
          });

    bind(this.bindings, created.id, args.syncId);
    this.loopGuard.expect({
      localId: created.id,
      kind: args.kind,
      parentLocalId,
      title: args.title,
      url: args.kind === "bookmark" ? (args.url ?? "") : null,
    });
    return true;
  }

  private sortCanonicalNodes<T extends { syncId: string; parentSyncId: string | null }>(
    nodes: T[],
  ): T[] {
    const byId = new Map(nodes.map((node) => [node.syncId, node]));
    const depthCache = new Map<string, number>();
    const visiting = new Set<string>();

    const depthOf = (node: T): number => {
      const cached = depthCache.get(node.syncId);
      if (cached !== undefined) return cached;
      if (!node.parentSyncId) {
        depthCache.set(node.syncId, 0);
        return 0;
      }
      if (visiting.has(node.syncId)) {
        depthCache.set(node.syncId, 1);
        return 1;
      }
      const parent = byId.get(node.parentSyncId);
      if (!parent) {
        depthCache.set(node.syncId, 1);
        return 1;
      }
      visiting.add(node.syncId);
      const depth = depthOf(parent) + 1;
      visiting.delete(node.syncId);
      depthCache.set(node.syncId, depth);
      return depth;
    };

    return [...nodes].sort((left, right) => depthOf(left) - depthOf(right));
  }

  private async pruneBindings(tree: LocalTree): Promise<void> {
    const present = new Set(tree.nodes.map((node) => node.localId));
    let changed = false;
    for (const localId of Object.keys(this.bindings.localToSync)) {
      if (!present.has(localId)) {
        unbindLocal(this.bindings, localId);
        changed = true;
      }
    }
    if (changed) await this.saveBindings();
  }

  private async removeLocalSubtree(syncId: string): Promise<boolean> {
    if (syncId.startsWith("root:")) return true;
    const localId = resolveLocalId(this.bindings, syncId);
    if (!localId) return true;

    const node = await getNode(localId);
    if (!node) {
      unbindLocal(this.bindings, localId);
      return true;
    }

    const subtree = await getSubtree(localId);
    const localIds = subtree.length > 0 ? subtree.map((entry) => entry.id) : [localId];
    await removeNode(localId, typeof node.url !== "string");
    for (const id of localIds) unbindLocal(this.bindings, id);
    return true;
  }

  private enrich(tree: LocalTree): SnapshotNode[] {
    return tree.nodes.map((node) => {
      const syncId = resolveSyncId(this.bindings, node.localId) ?? null;
      return { ...node, syncId };
    });
  }

  private async rootLocalIds(): Promise<Map<string, string>> {
    const tree = await readTree();
    const roots = new Map<string, string>();
    for (const node of tree.nodes) {
      if (node.rootKey && node.parentLocalId === null) {
        roots.set(ROOT_SYNC_IDS[node.rootKey], node.localId);
      }
    }
    return roots;
  }

  private async applyBindings(
    entries: Array<{ localId: string; syncId: string }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) {
      bind(this.bindings, entry.localId, entry.syncId);
    }
    await this.saveBindings();
  }

  private async saveBindings(): Promise<void> {
    await chrome.storage.local.set({ [BINDINGS_KEY]: this.bindings });
  }

  private async recordConflicts(conflicts: Conflict[]): Promise<void> {
    if (conflicts.length === 0) return;

    const stored = await chrome.storage.local.get(CONFLICTS_KEY);
    const existing = Array.isArray(stored[CONFLICTS_KEY])
      ? (stored[CONFLICTS_KEY] as StoredConflict[])
      : [];
    const now = Date.now();
    const next: StoredConflict[] = [
      ...conflicts.map((conflict) => ({
        syncId: conflict.syncId,
        kind: conflict.kind,
        resolution: conflict.resolution,
        detail: conflict.detail,
        at: now,
      })),
      ...existing,
    ].slice(0, 50);

    await chrome.storage.local.set({ [CONFLICTS_KEY]: next });
    this.updateStatus({ conflicts: next.length });
  }

  private enqueueOps(message: OpsMessage): void {
    this.unsolicitedQueue.push(message);
    queueMicrotask(() => {
      if (!this.syncing) void this.flushOps();
    });
  }

  private async flushOps(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      await this.ensureStateLoaded();
      const settings = await loadSettings();
      if (!settings.paired || settings.paused) {
        // Before pairing, applying remote adds would create copies of local
        // bookmarks that have no sync identity yet. The pull after pairing
        // will fetch everything anyway.
        this.unsolicitedQueue.length = 0;
        return;
      }

      while (this.unsolicitedQueue.length > 0) {
        const message = this.unsolicitedQueue.shift();
        if (!message) break;
        const changes = message.changes.filter((change) => change.seq > this.lastSeq);
        if (changes.length > 0) await this.applyChanges(changes);
        await this.acknowledge(message.seq);
      }
      this.updateStatus({ lastSyncAt: Date.now() });
    } catch (error) {
      this.updateStatus({
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.syncing = false;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const settings = this.settings;
    if (!settings) return;
    if (!settings.token) {
      this.updateStatus({ state: "error", message: "未配置中继令牌，请打开设置" });
      return;
    }
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.updateStatus({ state: "connecting" });

    let socket: WebSocket;
    try {
      socket = new WebSocket(settings.relayUrl);
    } catch (error) {
      this.updateStatus({ state: "error", message: `无法创建连接：${String(error)}` });
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    socket.addEventListener("open", () => this.handleOpen(socket));
    socket.addEventListener("message", (event) => this.handleMessage(socket, event));
    socket.addEventListener("close", () => this.handleClose(socket));
    socket.addEventListener("error", () => {
      if (this.socket === socket) {
        this.updateStatus({ state: "error", message: "WebSocket 连接错误" });
      }
    });
  }

  private handleOpen(socket: WebSocket): void {
    if (this.socket !== socket) return;
    const settings = this.settings;
    if (!settings) return;

    this.lastReceivedAt = Date.now();
    this.sendRaw({
      v: PROTOCOL_VERSION,
      type: "hello",
      requestId: crypto.randomUUID(),
      ts: Date.now(),
      endpointId: endpointIdFor(settings),
      installId: settings.installId,
      browser: settings.browser,
      profileLabel: settings.profileLabel,
      clientVersion: CLIENT_VERSION,
      token: settings.token,
      lastSeq: this.lastSeq,
    });
    this.startTimers(socket);
  }

  private handleMessage(socket: WebSocket, event: MessageEvent): void {
    if (this.socket !== socket) return;
    this.lastReceivedAt = Date.now();
    if (typeof event.data !== "string") return;

    let json: unknown;
    try {
      json = JSON.parse(event.data);
    } catch {
      return;
    }

    const parsed = safeParseServerMessage(json);
    if (!parsed.success) return;
    const message = parsed.data;

    const requestId = "requestId" in message ? message.requestId : undefined;
    if (requestId) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        if (message.type === "error") {
          pending.reject(new Error(`${message.code}: ${message.message}`));
        } else {
          pending.resolve(message);
        }
        return;
      }
    }

    switch (message.type) {
      case "welcome": {
        this.reconnectDelay = 1_000;
        this.needsResync = message.resume === "snapshot";
        this.updateStatus({ state: "connected", message: undefined });
        this.options.onWelcome?.(message);
        void this.runSync("welcome");
        return;
      }
      case "pong":
        return;
      case "error": {
        if (message.code === "AUTH_FAILED") {
          this.updateStatus({ state: "error", message: message.message });
          this.stop();
        } else {
          this.updateStatus({ message: message.message });
        }
        return;
      }
      case "ops": {
        this.enqueueOps(message);
        return;
      }
      case "push-result":
      case "snapshot": {
        this.options.onServerMessage?.(message);
        return;
      }
      default:
        return;
    }
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.clearTimers();
    this.updateStatus({ state: "disconnected" });
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.stopped) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectWithFreshSettings();
    }, delay);
  }

  private async reconnectWithFreshSettings(): Promise<void> {
    if (this.stopped) return;
    this.settings = await loadSettings();
    if (this.settings.paused) return;
    this.connect();
  }

  private startTimers(socket: WebSocket): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      this.sendRaw({ v: PROTOCOL_VERSION, type: "ping", ts: Date.now() });
    }, PING_INTERVAL_MS);
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastReceivedAt > WATCHDOG_TIMEOUT_MS) {
        try {
          socket.close(4000, "heartbeat timeout");
        } catch {
          // ignore
        }
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private request(message: ClientMessage, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ServerMessage> {
    const requestId = "requestId" in message ? message.requestId : undefined;
    if (!requestId) return Promise.reject(new Error("请求缺少 requestId"));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("中继请求超时"));
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(error);
        },
        timer,
      });

      if (!this.sendRaw(message)) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error("未连接到中继"));
      }
    });
  }

  private sendRaw(message: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private updateStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch, at: Date.now() };
    if (this.status.message === undefined) delete this.status.message;
    this.options.onStatus?.(this.status);
  }

  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) return;
    const stored = await chrome.storage.local.get([
      BINDINGS_KEY,
      PREVIEW_KEY,
      LAST_PUSHED_HASH_KEY,
    ]);
    this.bindings = bindingsFromJSON(stored[BINDINGS_KEY]);
    this.preview = (stored[PREVIEW_KEY] as SyncPreview | undefined) ?? null;
    this.lastPushedHash =
      typeof stored[LAST_PUSHED_HASH_KEY] === "string"
        ? stored[LAST_PUSHED_HASH_KEY]
        : null;
    this.stateLoaded = true;
  }

  private async readLastSeq(): Promise<number> {
    const stored = await chrome.storage.local.get(LAST_SEQ_KEY);
    const value = stored[LAST_SEQ_KEY];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  private async writeLastSeq(seq: number): Promise<void> {
    await chrome.storage.local.set({ [LAST_SEQ_KEY]: seq });
  }

  private async readPreview(): Promise<SyncPreview | null> {
    const stored = await chrome.storage.local.get(PREVIEW_KEY);
    const preview = stored[PREVIEW_KEY] as SyncPreview | undefined;
    return preview ?? null;
  }
}
