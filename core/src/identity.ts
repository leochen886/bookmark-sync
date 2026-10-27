import { sha256Hex } from "./hash";
import type { RootKey } from "./model";

export function normalizeText(value: string): string {
  return value.normalize("NFC").trim();
}

/**
 * Conservative URL normalization: scheme and host are lowercased, the rest is
 * preserved (query order, fragments and trailing slashes stay untouched).
 */
export function normalizeUrl(value: string | null): string {
  if (value === null) return "";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function buildParentPath(rootKey: RootKey, folderTitles: readonly string[]): string {
  return [rootKey, ...folderTitles.map(normalizeText)].join("/");
}

export function contentKey(parentPath: string, title: string, url: string | null): string {
  return sha256Hex(
    `${normalizeText(parentPath)}\u0000${normalizeText(title)}\u0000${normalizeUrl(url)}`,
  );
}

export interface SyncBindings {
  localToSync: Record<string, string>;
  syncToLocal: Record<string, string>;
}

export function createBindings(): SyncBindings {
  return { localToSync: {}, syncToLocal: {} };
}

export function bind(bindings: SyncBindings, localId: string, syncId: string): void {
  const previousSyncId = bindings.localToSync[localId];
  if (previousSyncId && previousSyncId !== syncId) {
    delete bindings.syncToLocal[previousSyncId];
  }
  const previousLocalId = bindings.syncToLocal[syncId];
  if (previousLocalId && previousLocalId !== localId) {
    delete bindings.localToSync[previousLocalId];
  }
  bindings.localToSync[localId] = syncId;
  bindings.syncToLocal[syncId] = localId;
}

export function unbindLocal(bindings: SyncBindings, localId: string): void {
  const syncId = bindings.localToSync[localId];
  if (!syncId) return;
  delete bindings.localToSync[localId];
  if (bindings.syncToLocal[syncId] === localId) {
    delete bindings.syncToLocal[syncId];
  }
}

export function resolveSyncId(bindings: SyncBindings, localId: string): string | undefined {
  return bindings.localToSync[localId];
}

export function resolveLocalId(bindings: SyncBindings, syncId: string): string | undefined {
  return bindings.syncToLocal[syncId];
}

export function bindingsFromJSON(raw: unknown): SyncBindings {
  const bindings = createBindings();
  if (!raw || typeof raw !== "object") return bindings;
  const candidate = raw as Partial<SyncBindings>;
  if (candidate.localToSync && typeof candidate.localToSync === "object") {
    for (const [localId, syncId] of Object.entries(candidate.localToSync)) {
      if (typeof syncId === "string") bind(bindings, localId, syncId);
    }
  }
  return bindings;
}
