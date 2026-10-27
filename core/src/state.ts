import { contentKey } from "./identity";
import {
  ROOT_SYNC_IDS,
  SCHEMA_VERSION,
  type CanonicalState,
  type RootKey,
  type SyncNode,
} from "./model";

const ROOT_TITLES: Record<RootKey, string> = {
  bookmark_bar: "Bookmarks Bar",
  other: "Other Bookmarks",
};

export function createRootNode(
  rootKey: RootKey,
  now = 0,
  origin = "system",
): SyncNode {
  const title = ROOT_TITLES[rootKey];
  return {
    syncId: ROOT_SYNC_IDS[rootKey],
    kind: "folder",
    title,
    url: null,
    parentSyncId: null,
    rootKey,
    position: rootKey === "bookmark_bar" ? 0 : 1,
    createdAt: now,
    modifiedAt: now,
    origin,
    rev: 1,
    deleted: false,
    deletedAt: null,
    contentKey: contentKey(`root:${rootKey}`, title, null),
  };
}

export function ensureRootNode(
  state: CanonicalState,
  rootKey: RootKey,
  now = 0,
  origin = "system",
): SyncNode {
  const syncId = ROOT_SYNC_IDS[rootKey];
  const existing = state.nodes[syncId];
  if (existing) return existing;
  const node = createRootNode(rootKey, now, origin);
  state.nodes[syncId] = node;
  return node;
}

export function createInitialState(): CanonicalState {
  const bookmarkBar = createRootNode("bookmark_bar");
  const other = createRootNode("other");
  return {
    schemaVersion: SCHEMA_VERSION,
    seq: 0,
    nodes: {
      [bookmarkBar.syncId]: bookmarkBar,
      [other.syncId]: other,
    },
    tombstones: {},
    endpoints: {},
    snapshots: {},
    changes: [],
  };
}
