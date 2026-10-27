import { normalizeText } from "./identity";
import { sha256Hex } from "./hash";
import type { RootKey, SnapshotNode } from "./model";

export interface SnapshotDiff {
  added: SnapshotNode[];
  updated: Array<{ node: SnapshotNode; previous: SnapshotNode }>;
  moved: Array<{ node: SnapshotNode; previous: SnapshotNode }>;
  removed: SnapshotNode[];
}

export function diffSnapshot(
  previous: SnapshotNode[] | undefined,
  next: SnapshotNode[],
): SnapshotDiff {
  const previousById = new Map((previous ?? []).map((node) => [node.localId, node]));
  const nextIds = new Set(next.map((node) => node.localId));

  const added: SnapshotNode[] = [];
  const updated: Array<{ node: SnapshotNode; previous: SnapshotNode }> = [];
  const moved: Array<{ node: SnapshotNode; previous: SnapshotNode }> = [];

  for (const node of next) {
    const before = previousById.get(node.localId);
    if (!before) {
      added.push(node);
      continue;
    }
    if (
      before.kind !== node.kind ||
      before.title !== node.title ||
      before.url !== node.url
    ) {
      updated.push({ node, previous: before });
    }
    if (
      before.parentLocalId !== node.parentLocalId ||
      before.position !== node.position
    ) {
      moved.push({ node, previous: before });
    }
  }

  const removed = (previous ?? []).filter((node) => !nextIds.has(node.localId));
  return { added, updated, moved, removed };
}

/** Parents before children, so a folder exists before its contents are created. */
export function sortParentsFirst(nodes: SnapshotNode[]): SnapshotNode[] {
  const byLocalId = new Map(nodes.map((node) => [node.localId, node]));
  const depthCache = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (node: SnapshotNode): number => {
    const cached = depthCache.get(node.localId);
    if (cached !== undefined) return cached;
    if (node.rootKey) {
      depthCache.set(node.localId, 0);
      return 0;
    }
    if (!node.parentLocalId) {
      depthCache.set(node.localId, 1);
      return 1;
    }
    if (visiting.has(node.localId)) {
      depthCache.set(node.localId, 1);
      return 1;
    }
    const parent = byLocalId.get(node.parentLocalId);
    if (!parent) {
      depthCache.set(node.localId, 1);
      return 1;
    }
    visiting.add(node.localId);
    const depth = depthOf(parent) + 1;
    visiting.delete(node.localId);
    depthCache.set(node.localId, depth);
    return depth;
  };

  return [...nodes].sort((left, right) => {
    const byDepth = depthOf(left) - depthOf(right);
    if (byDepth !== 0) return byDepth;
    if (left.position !== right.position) return left.position - right.position;
    return left.localId.localeCompare(right.localId, undefined, { numeric: true });
  });
}

/**
 * Path used as the parent component of a content key.
 * Root folders resolve to their rootKey; nested folders to "root/Title/Title".
 */
export function parentPaths(nodes: SnapshotNode[]): Map<string, string> {
  const byLocalId = new Map(nodes.map((node) => [node.localId, node]));
  const paths = new Map<string, string>();
  const visiting = new Set<string>();

  const pathOf = (node: SnapshotNode): string => {
    const cached = paths.get(node.localId);
    if (cached !== undefined) return cached;

    let path: string;
    if (node.rootKey) {
      path = node.rootKey;
    } else if (!node.parentLocalId) {
      path = "other";
    } else {
      const parent = byLocalId.get(node.parentLocalId);
      if (!parent) {
        path = "other";
      } else if (parent.rootKey) {
        path = parent.rootKey;
      } else if (visiting.has(node.localId)) {
        path = "other";
      } else {
        visiting.add(node.localId);
        path = `${pathOf(parent)}/${normalizeText(parent.title)}`;
        visiting.delete(node.localId);
      }
    }

    paths.set(node.localId, path);
    return path;
  };

  for (const node of nodes) pathOf(node);
  return paths;
}

export function parentPathFor(node: SnapshotNode, paths: Map<string, string>): string {
  if (node.rootKey) return node.rootKey;
  if (!node.parentLocalId) return "other";
  return paths.get(node.parentLocalId) ?? "other";
}

/**
 * Stable hash of one endpoint's tree. Local ids are included because the hash
 * is only compared against the same endpoint's previous push. Sorted so a
 * reordered Map iteration cannot change it.
 */
export function snapshotHash(roots: RootKey[], nodes: SnapshotNode[]): string {
  const sorted = [...nodes].sort((left, right) =>
    left.localId.localeCompare(right.localId, undefined, { numeric: true }),
  );
  const payload = {
    roots: [...roots].sort(),
    nodes: sorted.map((node) => [
      node.localId,
      node.parentLocalId,
      node.rootKey,
      node.kind,
      node.title,
      node.url,
      node.position,
      node.dateAdded,
      node.syncId ?? null,
    ]),
  };
  return sha256Hex(JSON.stringify(payload));
}
