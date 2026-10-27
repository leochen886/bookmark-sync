import type { Conflict, Counts } from "@bookmark-sync/core/protocol";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "preview";

export interface SyncStatus {
  state: ConnectionState;
  at: number;
  lastSyncAt?: number;
  pending?: number;
  conflicts?: number;
  message?: string;
}

export interface SyncPreview {
  requestId: string;
  snapshotHash: string;
  counts: Counts;
  conflicts: Conflict[];
  at: number;
}

export interface StoredConflict {
  syncId: string;
  kind: string;
  resolution: string;
  detail: string;
  at: number;
}

export const STATUS_KEY = "sync.status";
export const LAST_SEQ_KEY = "sync.lastSeq";
export const BINDINGS_KEY = "sync.bindings";
export const PREVIEW_KEY = "sync.preview";
export const LAST_PUSHED_HASH_KEY = "sync.lastPushedHash";
export const CONFLICTS_KEY = "sync.conflicts";
