import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  SCHEMA_VERSION,
  createInitialState,
  normalizeSiblingPositions,
  type CanonicalState,
} from "@bookmark-sync/core";

export interface StateStoreOptions {
  dataDir?: string;
  keepBackups?: number;
  backupIntervalMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSyncNodeRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.syncId === "string" &&
    (value.kind === "bookmark" || value.kind === "folder") &&
    typeof value.title === "string" &&
    (value.url === null || typeof value.url === "string") &&
    (value.parentSyncId === null || typeof value.parentSyncId === "string") &&
    (value.rootKey === null ||
      value.rootKey === "bookmark_bar" ||
      value.rootKey === "other") &&
    typeof value.position === "number" &&
    typeof value.createdAt === "number" &&
    typeof value.modifiedAt === "number" &&
    typeof value.origin === "string" &&
    typeof value.rev === "number" &&
    typeof value.deleted === "boolean" &&
    (value.deletedAt === null || typeof value.deletedAt === "number") &&
    typeof value.contentKey === "string"
  );
}

function isCanonicalState(value: unknown): value is CanonicalState {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === SCHEMA_VERSION &&
    typeof value.seq === "number" &&
    isRecord(value.nodes) &&
    Object.values(value.nodes).every(isSyncNodeRecord) &&
    isRecord(value.tombstones) &&
    isRecord(value.endpoints) &&
    isRecord(value.snapshots) &&
    Array.isArray(value.changes)
  );
}

export class StateStore {
  private state: CanonicalState;
  private queue: Promise<unknown> = Promise.resolve();
  private lastBackupAt = 0;

  private constructor(
    state: CanonicalState,
    readonly dataDir: string,
    private readonly keepBackups: number,
    private readonly backupIntervalMs: number,
  ) {
    this.state = state;
  }

  static async open(options: StateStoreOptions = {}): Promise<StateStore> {
    const dataDir = resolve(options.dataDir ?? join(process.cwd(), "relay", "data"));
    await mkdir(dataDir, { recursive: true });

    const store = new StateStore(
      createInitialState(),
      dataDir,
      options.keepBackups ?? 5,
      options.backupIntervalMs ?? 5 * 60_000,
    );
    await store.load();
    return store;
  }

  getState(): CanonicalState {
    return this.state;
  }

  async mutate<T>(mutator: (state: CanonicalState) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const result = await mutator(this.state);
      await this.save();
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async save(forceBackup = false): Promise<void> {
    if (forceBackup || Date.now() - this.lastBackupAt >= this.backupIntervalMs) {
      await this.rotateBackup();
      this.lastBackupAt = Date.now();
    }
    await this.writeState();
  }

  async backupNow(): Promise<string | null> {
    return this.copyPrimaryToBackup();
  }

  /** Waits for queued mutations to finish; used during graceful shutdown. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private async load(): Promise<void> {
    const statePath = join(this.dataDir, "state.json");
    const primary = await this.tryRead(statePath);
    if (primary) {
      this.state = primary;
      this.markEndpointsOffline();
      normalizeSiblingPositions(this.state);
      await this.writeState();
      return;
    }

    if (existsSync(statePath)) {
      const corruptPath = join(this.dataDir, `state.corrupt-${Date.now()}.json`);
      try {
        await rename(statePath, corruptPath);
        console.warn(`[relay] state.json was invalid; moved to ${corruptPath}`);
      } catch (error) {
        console.warn("[relay] state.json was invalid and could not be moved", error);
      }
    }

    for (const backupPath of await this.listBackups()) {
      const backup = await this.tryRead(backupPath);
      if (backup) {
        this.state = backup;
        this.markEndpointsOffline();
        normalizeSiblingPositions(this.state);
        console.warn(`[relay] restored state from ${backupPath}`);
        await this.writeState();
        return;
      }
    }

    this.state = createInitialState();
    await this.writeState();
  }

  private markEndpointsOffline(): void {
    for (const endpoint of Object.values(this.state.endpoints)) {
      endpoint.status = "offline";
    }
  }

  private async tryRead(filePath: string): Promise<CanonicalState | null> {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isCanonicalState(parsed)) {
        console.warn(`[relay] ignoring invalid state file: ${filePath}`);
        return null;
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[relay] failed to read ${filePath}`, error);
      }
      return null;
    }
  }

  private async writeState(): Promise<void> {
    const statePath = join(this.dataDir, "state.json");
    const tempPath = join(
      this.dataDir,
      `state.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    );
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await this.replaceFile(tempPath, statePath);
  }

  /**
   * Windows can briefly lock a freshly written file (antivirus, indexer), which
   * surfaces as EPERM/EBUSY on rename. Retry with backoff, then fall back to a
   * direct write so a sync is never lost to a transient lock.
   */
  private async replaceFile(tempPath: string, statePath: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await rename(tempPath, statePath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
        lastError = error;
        await delay(25 * (attempt + 1));
      }
    }

    try {
      const content = await readFile(tempPath, "utf8");
      await writeFile(statePath, content, "utf8");
      await rm(tempPath, { force: true });
    } catch {
      throw lastError ?? new Error("failed to replace relay state file");
    }
  }

  private async rotateBackup(): Promise<void> {
    const backupPath = await this.copyPrimaryToBackup();
    if (!backupPath) return;
    const backups = await this.listBackups();
    for (const stale of backups.slice(this.keepBackups)) {
      await rm(stale, { force: true });
    }
  }

  private async copyPrimaryToBackup(): Promise<string | null> {
    const statePath = join(this.dataDir, "state.json");
    if (!existsSync(statePath)) return null;
    const backupPath = join(
      this.dataDir,
      `backup-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`,
    );
    await copyFile(statePath, backupPath);
    return backupPath;
  }

  private async listBackups(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dataDir);
    } catch {
      return [];
    }
    const stampOf = (name: string): number => {
      const match = /^backup-(\d+)/.exec(name);
      return match ? Number(match[1]) : 0;
    };

    return entries
      .filter((name) => /^backup-\d+(?:-[0-9a-f]+)?\.json$/.test(name))
      .sort((left, right) => stampOf(right) - stampOf(left))
      .map((name) => join(this.dataDir, name));
  }
}
