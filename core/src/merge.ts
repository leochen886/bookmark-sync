import { diffSnapshot, parentPathFor, parentPaths, sortParentsFirst } from "./diff";
import { contentKey, normalizeText } from "./identity";
import {
  ROOT_SYNC_IDS,
  clampTitle,
  type CanonicalState,
  type Change,
  type ChangePayload,
  type EndpointSnapshot,
  type RootKey,
  type SnapshotNode,
  type SyncNode,
  type Tombstone,
} from "./model";
import type { Conflict, Counts } from "./protocol";
import { ensureRootNode } from "./state";

export type PendingChange = Omit<Change, "seq">;

export interface MergePushInput {
  state: CanonicalState;
  endpointId: string;
  push: { roots: RootKey[]; nodes: SnapshotNode[] };
  previous?: EndpointSnapshot;
  newSyncId: () => string;
  now: number;
}

export interface MergePushOutcome {
  counts: Counts;
  conflicts: Conflict[];
  bindings: Array<{ localId: string; syncId: string }>;
  changes: PendingChange[];
  tombstones: Array<Omit<Tombstone, "seq">>;
  snapshotNodes: SnapshotNode[];
}

interface ParentResolution {
  parentSyncId: string;
  missing: boolean;
  detail: string;
}

function normalizePosition(position: number): number {
  return Number.isFinite(position) ? Math.max(0, Math.trunc(position)) : 0;
}

function isDescendantOf(
  state: CanonicalState,
  candidateSyncId: string,
  ancestorSyncId: string,
): boolean {
  const seen = new Set<string>();
  let current: string | null = candidateSyncId;

  while (current && !seen.has(current)) {
    if (current === ancestorSyncId) return true;
    seen.add(current);
    const node: SyncNode | undefined = state.nodes[current];
    current = node?.parentSyncId ?? null;
  }
  return false;
}

/** True when moving syncId under newParentSyncId would create a folder cycle. */
export function wouldCreateCycle(
  state: CanonicalState,
  syncId: string,
  newParentSyncId: string | null,
): boolean {
  if (!newParentSyncId) return false;
  if (newParentSyncId === syncId) return true;
  return isDescendantOf(state, newParentSyncId, syncId);
}

/** Path of the folder that contains this node, used for content keys. */
function folderPath(
  state: CanonicalState,
  syncId: string,
  seen = new Set<string>(),
): string {
  const node = state.nodes[syncId];
  if (!node) return "other";
  if (node.rootKey) return node.rootKey;
  if (!node.parentSyncId) return "other";
  if (seen.has(syncId)) return "other";
  seen.add(syncId);

  const parent = state.nodes[node.parentSyncId];
  if (!parent) return "other";
  if (parent.rootKey) return parent.rootKey;
  return `${folderPath(state, parent.syncId, seen)}/${normalizeText(parent.title)}`;
}

/**
 * A rename or move changes the path of every descendant, so their content keys
 * must be recomputed or later merges will fail to match them.
 */
function refreshContentKeys(
  state: CanonicalState,
  syncId: string,
  visited = new Set<string>(),
): void {
  if (visited.has(syncId)) return;
  visited.add(syncId);

  const node = state.nodes[syncId];
  if (!node) return;
  node.contentKey = contentKey(folderPath(state, syncId), node.title, node.url);

  for (const candidate of Object.values(state.nodes)) {
    if (candidate.parentSyncId === syncId) {
      refreshContentKeys(state, candidate.syncId, visited);
    }
  }
}

export function normalizeSiblingPositions(state: CanonicalState): void {
  const children = new Map<string, SyncNode[]>();
  for (const node of Object.values(state.nodes)) {
    // Deleted nodes must not occupy a position or be visited as live children.
    if (node.deleted || !node.parentSyncId) continue;
    const list = children.get(node.parentSyncId);
    if (list) list.push(node);
    else children.set(node.parentSyncId, [node]);
  }

  for (const siblings of children.values()) {
    siblings.sort(
      (left, right) =>
        left.position - right.position ||
        left.createdAt - right.createdAt ||
        left.syncId.localeCompare(right.syncId),
    );
    siblings.forEach((sibling, index) => {
      sibling.position = index;
    });
  }
}

/** Rejects a batch that reports the same local or sync identity twice. */
export function validatePushSnapshot(nodes: SnapshotNode[]): string | null {
  const localIds = new Set<string>();
  const syncIds = new Set<string>();

  for (const node of nodes) {
    if (localIds.has(node.localId)) return `duplicate localId: ${node.localId}`;
    localIds.add(node.localId);

    if (node.syncId) {
      if (syncIds.has(node.syncId)) return `duplicate syncId: ${node.syncId}`;
      syncIds.add(node.syncId);
    }
  }

  return null;
}

function resolveParent(
  node: SnapshotNode,
  byLocalId: Map<string, SnapshotNode>,
  resolved: Map<string, string>,
  state: CanonicalState,
): ParentResolution {
  if (!node.parentLocalId) {
    return {
      parentSyncId: ROOT_SYNC_IDS.other,
      missing: true,
      detail: "node has no parent local id",
    };
  }
  const parent = byLocalId.get(node.parentLocalId);
  if (!parent) {
    return {
      parentSyncId: ROOT_SYNC_IDS.other,
      missing: true,
      detail: `parent ${node.parentLocalId} is missing from the push`,
    };
  }
  const parentSyncId = resolved.get(parent.localId);
  if (!parentSyncId) {
    return {
      parentSyncId: ROOT_SYNC_IDS.other,
      missing: true,
      detail: `parent ${node.parentLocalId} has no sync identity`,
    };
  }

  const parentNode = state.nodes[parentSyncId];
  if (!parentNode || parentNode.deleted) {
    return {
      parentSyncId: ROOT_SYNC_IDS.other,
      missing: true,
      detail: `parent ${parentSyncId} is deleted; attached to Other Bookmarks`,
    };
  }

  return { parentSyncId, missing: false, detail: "" };
}

function findContentMatch(
  state: CanonicalState,
  node: SnapshotNode,
  key: string,
  used: Set<string>,
): SyncNode | null {
  const candidates = Object.values(state.nodes)
    .filter(
      (candidate) =>
        !candidate.rootKey &&
        !candidate.deleted &&
        candidate.kind === node.kind &&
        candidate.contentKey === key &&
        !used.has(candidate.syncId),
    )
    .sort((left, right) => left.syncId.localeCompare(right.syncId));
  return candidates[0] ?? null;
}

function createCanonicalNode(args: {
  syncId: string;
  node: SnapshotNode;
  parentSyncId: string;
  contentKeyValue: string;
  endpointId: string;
  now: number;
}): SyncNode {
  const { syncId, node, parentSyncId, contentKeyValue, endpointId, now } = args;
  const title = clampTitle(node.title);
  const url = node.kind === "bookmark" ? (node.url ?? "") : null;
  const position = normalizePosition(node.position);
  const createdAt = node.dateAdded && node.dateAdded > 0 ? node.dateAdded : now;
  const modifiedAt = node.modifiedAt && node.modifiedAt > 0 ? node.modifiedAt : createdAt;

  return {
    syncId,
    kind: node.kind,
    title,
    url,
    parentSyncId,
    rootKey: null,
    position,
    createdAt,
    modifiedAt,
    origin: endpointId,
    rev: 1,
    deleted: false,
    deletedAt: null,
    contentKey: contentKeyValue,
  };
}

function collectPreviousSubtree(
  allPreviousNodes: SnapshotNode[],
  root: SnapshotNode,
): SnapshotNode[] {
  const children = new Map<string, SnapshotNode[]>();
  for (const node of allPreviousNodes) {
    if (!node.parentLocalId) continue;
    const list = children.get(node.parentLocalId);
    if (list) list.push(node);
    else children.set(node.parentLocalId, [node]);
  }

  const out: SnapshotNode[] = [];
  const stack: SnapshotNode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    out.push(current);
    for (const child of children.get(current.localId) ?? []) stack.push(child);
  }
  return out;
}

function collectCanonicalSubtree(state: CanonicalState, rootSyncId: string): SyncNode[] {
  const children = new Map<string, SyncNode[]>();
  for (const node of Object.values(state.nodes)) {
    // Traverse every node; callers filter deleted entries themselves. Pruning
    // here would hide a live node stranded under a deleted ancestor.
    if (!node.parentSyncId) continue;
    const list = children.get(node.parentSyncId);
    if (list) list.push(node);
    else children.set(node.parentSyncId, [node]);
  }

  const out: SyncNode[] = [];
  const stack: SyncNode[] = [];
  const root = state.nodes[rootSyncId];
  if (root) stack.push(root);
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    out.push(current);
    for (const child of children.get(current.syncId) ?? []) stack.push(child);
  }
  return out;
}

/**
 * A deletion loses against any edit that happened after the deleting endpoint's
 * last snapshot, and against any node added by another endpoint inside the
 * deleted subtree. Both would silently drop user data (FR-006, SC-007).
 */
function describeSubtreeConflict(
  state: CanonicalState,
  subtree: SnapshotNode[],
  rootSyncId: string,
): string | null {
  const seenSyncIds = new Set<string>();

  for (const node of subtree) {
    if (node.syncId) seenSyncIds.add(node.syncId);
    if (!node.syncId) continue;
    const canonical = state.nodes[node.syncId];
    if (!canonical) continue;
    const expectedTitle = clampTitle(node.title);
    const expectedUrl = node.kind === "bookmark" ? (node.url ?? "") : null;
    if (
      canonical.kind !== node.kind ||
      canonical.title !== expectedTitle ||
      canonical.url !== expectedUrl
    ) {
      return `node ${node.syncId} changed after this endpoint's last snapshot`;
    }
  }

  for (const canonical of collectCanonicalSubtree(state, rootSyncId)) {
    if (canonical.deleted) continue;
    if (!seenSyncIds.has(canonical.syncId)) {
      return `node ${canonical.syncId} was added by another endpoint inside the deleted subtree`;
    }
  }

  return null;
}

/**
 * Merges one endpoint's pushed tree into canonical state.
 *
 * US1: union of additions and title/url updates.
 * US2: deletions with tombstones, delete-vs-edit conflicts and resurrection.
 * Structural moves are layered in by T033.
 */
export function mergePush(input: MergePushInput): MergePushOutcome {
  const { state, endpointId, push, previous, newSyncId, now } = input;

  const counts: Counts = {
    added: 0,
    updated: 0,
    moved: 0,
    deleted: 0,
    resurrected: 0,
    conflicts: 0,
  };
  const conflicts: Conflict[] = [];
  const changes: PendingChange[] = [];
  const tombstones: Array<Omit<Tombstone, "seq">> = [];
  const bindings: Array<{ localId: string; syncId: string }> = [];

  const previousById = new Map((previous?.nodes ?? []).map((node) => [node.localId, node]));
  const byLocalId = new Map(push.nodes.map((node) => [node.localId, node]));
  const paths = parentPaths(push.nodes);
  const ordered = sortParentsFirst(push.nodes);
  const resolved = new Map<string, string>();
  const used = new Set<string>();

  // Resolve roots and identities this endpoint already knows about.
  for (const node of push.nodes) {
    if (node.rootKey) {
      ensureRootNode(state, node.rootKey, now, endpointId);
      const syncId = ROOT_SYNC_IDS[node.rootKey];
      resolved.set(node.localId, syncId);
      used.add(syncId);
      const before = node.syncId ?? previousById.get(node.localId)?.syncId ?? null;
      if (before !== syncId) bindings.push({ localId: node.localId, syncId });
      continue;
    }

    const known = node.syncId ?? previousById.get(node.localId)?.syncId ?? null;
    if (known && state.nodes[known]) {
      resolved.set(node.localId, known);
      used.add(known);
    }
  }

  for (const node of ordered) {
    if (node.rootKey) continue;

    const parentInfo = resolveParent(node, byLocalId, resolved, state);
    const parentPath = parentPathFor(node, paths);
    const key = contentKey(parentPath, node.title, node.url);

    const wasKnown = Boolean(resolved.get(node.localId));
    let syncId = resolved.get(node.localId);

    if (!syncId) {
      if (node.kind === "bookmark" && (!node.url || node.url.trim().length === 0)) {
        continue;
      }
      const match = findContentMatch(state, node, key, used);
      if (match) {
        syncId = match.syncId;
      } else {
        syncId = newSyncId();
        while (state.nodes[syncId] || used.has(syncId)) syncId = newSyncId();
      }
      resolved.set(node.localId, syncId);
    }
    used.add(syncId);

    let canonical = state.nodes[syncId];

    if (!canonical) {
      canonical = createCanonicalNode({
        syncId,
        node,
        parentSyncId: parentInfo.parentSyncId,
        contentKeyValue: key,
        endpointId,
        now,
      });
      state.nodes[syncId] = canonical;
      counts.added += 1;
      changes.push({
        type: "add",
        syncId,
        origin: endpointId,
        at: now,
        payload: {
          kind: canonical.kind,
          title: canonical.title,
          url: canonical.url,
          parentSyncId: canonical.parentSyncId,
          position: canonical.position,
        },
      });
    } else if (wasKnown && canonical.deleted) {
      const nextTitle = clampTitle(node.title);
      const nextUrl = node.kind === "bookmark" ? (node.url ?? "") : null;
      const contentChanged =
        canonical.kind !== node.kind ||
        canonical.title !== nextTitle ||
        canonical.url !== nextUrl ||
        canonical.parentSyncId !== parentInfo.parentSyncId;
      const newerThanTombstone =
        node.modifiedAt != null &&
        canonical.deletedAt != null &&
        node.modifiedAt > canonical.deletedAt;

      if (contentChanged || newerThanTombstone) {
        canonical.deleted = false;
        canonical.deletedAt = null;
        canonical.kind = node.kind;
        canonical.title = nextTitle;
        canonical.url = nextUrl;
        canonical.parentSyncId = parentInfo.parentSyncId;
        canonical.position = normalizePosition(node.position);
        canonical.modifiedAt = Math.max(canonical.modifiedAt, node.modifiedAt ?? now);
        canonical.rev += 1;
        canonical.origin = endpointId;
        refreshContentKeys(state, syncId);

        counts.resurrected += 1;
        conflicts.push({
          syncId,
          kind: "delete_vs_edit",
          resolution: "keep_modified",
          detail: "bookmark was modified after deletion; kept and resurrected",
        });
        changes.push({
          type: "undelete",
          syncId,
          origin: endpointId,
          at: canonical.modifiedAt,
          payload: {
            kind: canonical.kind,
            title: canonical.title,
            url: canonical.url,
            parentSyncId: canonical.parentSyncId,
            position: canonical.position,
          },
        });
      }
    } else if (wasKnown) {
      let changed = false;
      const updatePayload: ChangePayload = {};
      const nextTitle = clampTitle(node.title);
      const nextUrl = node.kind === "bookmark" ? (node.url ?? "") : null;

      if (canonical.title !== nextTitle) {
        canonical.title = nextTitle;
        updatePayload.title = nextTitle;
      }
      if (canonical.url !== nextUrl) {
        canonical.url = nextUrl;
        updatePayload.url = nextUrl;
      }

      const desiredPosition = normalizePosition(node.position);
      const parentChanged = canonical.parentSyncId !== parentInfo.parentSyncId;
      let movePayload: ChangePayload | null = null;

      if (parentChanged) {
        if (wouldCreateCycle(state, syncId, parentInfo.parentSyncId)) {
          conflicts.push({
            syncId,
            kind: "move_cycle",
            resolution: "reject_move",
            detail: `moving ${syncId} under ${parentInfo.parentSyncId} would create a cycle`,
          });
        } else {
          canonical.parentSyncId = parentInfo.parentSyncId;
          canonical.position = desiredPosition;
          movePayload = {
            parentSyncId: parentInfo.parentSyncId,
            position: desiredPosition,
          };
        }
      } else if (canonical.position !== desiredPosition) {
        canonical.position = desiredPosition;
        movePayload = {
          parentSyncId: canonical.parentSyncId,
          position: desiredPosition,
        };
      }

      const modifiedAt = node.modifiedAt && node.modifiedAt > 0 ? node.modifiedAt : now;

      if (Object.keys(updatePayload).length > 0) {
        canonical.modifiedAt = Math.max(canonical.modifiedAt, modifiedAt);
        changes.push({
          type: "update",
          syncId,
          origin: endpointId,
          at: canonical.modifiedAt,
          payload: updatePayload,
        });
        counts.updated += 1;
        changed = true;
      }

      if (movePayload) {
        canonical.modifiedAt = Math.max(canonical.modifiedAt, modifiedAt);
        changes.push({
          type: "move",
          syncId,
          origin: endpointId,
          at: canonical.modifiedAt,
          payload: movePayload,
        });
        counts.moved += 1;
        changed = true;
      }

      if (changed) {
        canonical.rev += 1;
        canonical.origin = endpointId;
        refreshContentKeys(state, syncId);
      }
    }

    if (parentInfo.missing) {
      // The canonical parent may differ from the pushed path (e.g. a deleted
      // folder was replaced by Other Bookmarks), so recompute the content key.
      refreshContentKeys(state, syncId);
      conflicts.push({
        syncId,
        kind: "missing_parent",
        resolution: "attach_to_other",
        detail: parentInfo.detail,
      });
    }

    const before = node.syncId ?? previousById.get(node.localId)?.syncId ?? null;
    if (before !== syncId) bindings.push({ localId: node.localId, syncId });
  }

  // Deletions: nodes the endpoint had last time but no longer reports.
  const removed = diffSnapshot(previous?.nodes, push.nodes).removed;
  if (removed.length > 0) {
    const removedSet = new Set(removed.map((node) => node.localId));
    const topLevel = sortParentsFirst(
      removed.filter(
        (node) => !node.parentLocalId || !removedSet.has(node.parentLocalId),
      ),
    );

    for (const rootRemoved of topLevel) {
      const rootSyncId = rootRemoved.syncId;
      if (!rootSyncId || rootSyncId.startsWith("root:")) continue;
      const canonicalRoot = state.nodes[rootSyncId];
      if (!canonicalRoot || canonicalRoot.deleted) continue;

      const endpointSubtree = collectPreviousSubtree(
        previous?.nodes ?? [],
        rootRemoved,
      ).filter((node) => removedSet.has(node.localId));

      const editDetail = describeSubtreeConflict(state, endpointSubtree, rootSyncId);
      if (editDetail) {
        conflicts.push({
          syncId: rootSyncId,
          kind: "delete_vs_edit",
          resolution: "delete_wins",
          detail: editDetail,
        });
      }

      // Two-way mirror: this deletion arrived last, so it wins for the whole
      // current canonical subtree, including children added by another endpoint.
      for (const canonical of collectCanonicalSubtree(state, rootSyncId)) {
        if (canonical.deleted) continue;

        canonical.deleted = true;
        canonical.deletedAt = now;
        canonical.rev += 1;
        canonical.origin = endpointId;

        const reason =
          canonical.syncId === rootSyncId ? "user_delete" : "parent_delete";
        state.tombstones[canonical.syncId] = {
          syncId: canonical.syncId,
          deletedAt: now,
          origin: endpointId,
          seq: 0,
          reason,
        };
        tombstones.push({
          syncId: canonical.syncId,
          deletedAt: now,
          origin: endpointId,
          reason,
        });

        counts.deleted += 1;
        changes.push({
          type: "delete",
          syncId: canonical.syncId,
          origin: endpointId,
          at: now,
          payload: { reason },
        });
      }
    }
  }

  normalizeSiblingPositions(state);
  counts.conflicts = conflicts.length;

  const snapshotNodes: SnapshotNode[] = push.nodes.map((node) => {
    const syncId = resolved.get(node.localId) ?? node.syncId ?? null;
    return syncId ? { ...node, syncId } : { ...node };
  });

  return { counts, conflicts, bindings, changes, tombstones, snapshotNodes };
}
