// Canonical data model shared by the relay, the extension and the tests.
// Field-level constraints mirror specs/001-bookmark-sync/data-model.md.

export const SCHEMA_VERSION = 1;
export const MAX_TITLE_LENGTH = 4096;
export const MAX_URL_LENGTH = 65536;

export type NodeKind = "bookmark" | "folder";
export type RootKey = "bookmark_bar" | "other";
export type BrowserKind = "chrome" | "ego";
export type EndpointStatus = "online" | "offline" | "paused";
export type DeleteReason = "user_delete" | "parent_delete";

export const ROOT_SYNC_IDS: Record<RootKey, string> = {
  bookmark_bar: "root:bookmark_bar",
  other: "root:other",
};

export interface SyncNode {
  syncId: string;
  kind: NodeKind;
  title: string;
  url: string | null;
  parentSyncId: string | null;
  rootKey: RootKey | null;
  position: number;
  createdAt: number;
  modifiedAt: number;
  origin: string;
  rev: number;
  deleted: boolean;
  deletedAt: number | null;
  contentKey: string;
}

export interface Tombstone {
  syncId: string;
  deletedAt: number;
  origin: string;
  seq: number;
  reason: DeleteReason;
}

export interface Endpoint {
  endpointId: string;
  browser: BrowserKind;
  profileLabel: string;
  tokenHash: string;
  lastSeq: number;
  lastSeenAt: number;
  lastSnapshotHash: string | null;
  status: EndpointStatus;
}

/**
 * One node as reported by a browser extension. localId is only meaningful
 * inside the reporting profile and must never leak into canonical state.
 */
export interface SnapshotNode {
  localId: string;
  parentLocalId: string | null;
  rootKey: RootKey | null;
  kind: NodeKind;
  title: string;
  url: string | null;
  position: number;
  dateAdded: number;
  syncId?: string | null;
  modifiedAt?: number | null;
}

export interface EndpointSnapshot {
  endpointId: string;
  seqAtCapture: number;
  capturedAt: number;
  hash: string;
  nodes: SnapshotNode[];
}

export type ChangeType = "add" | "update" | "move" | "delete" | "undelete";

export interface ChangePayload {
  kind?: NodeKind;
  title?: string;
  url?: string | null;
  parentSyncId?: string | null;
  position?: number;
  reason?: DeleteReason;
}

export interface Change {
  seq: number;
  type: ChangeType;
  syncId: string;
  origin: string;
  at: number;
  payload: ChangePayload;
}

export interface CanonicalState {
  schemaVersion: number;
  seq: number;
  nodes: Record<string, SyncNode>;
  tombstones: Record<string, Tombstone>;
  endpoints: Record<string, Endpoint>;
  snapshots: Record<string, EndpointSnapshot>;
  changes: Change[];
}

export function isRootSyncId(syncId: string): boolean {
  return syncId === ROOT_SYNC_IDS.bookmark_bar || syncId === ROOT_SYNC_IDS.other;
}

export function clampTitle(title: string): string {
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) : title;
}

export function validateSyncNode(node: SyncNode): string[] {
  const errors: string[] = [];
  if (node.kind === "bookmark" && (node.url === null || node.url.length === 0)) {
    errors.push("bookmark requires a non-empty url");
  }
  if (node.kind === "folder" && node.url !== null) {
    errors.push("folder must have url = null");
  }
  if (node.title.length > MAX_TITLE_LENGTH) {
    errors.push(`title exceeds ${MAX_TITLE_LENGTH} characters`);
  }
  if (node.url !== null && node.url.length > MAX_URL_LENGTH) {
    errors.push(`url exceeds ${MAX_URL_LENGTH} characters`);
  }
  if (!Number.isInteger(node.position) || node.position < 0) {
    errors.push("position must be a non-negative integer");
  }
  return errors;
}
