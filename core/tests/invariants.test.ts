import { describe, it } from "vitest";
import { mergePush } from "../src/merge";
import { createInitialState } from "../src/state";
import type {
  CanonicalState,
  EndpointSnapshot,
  RootKey,
  SnapshotNode,
  SyncNode,
} from "../src/model";

const CASES = 1_000;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Tree {
  roots: RootKey[];
  nodes: SnapshotNode[];
}

function buildTree(rng: () => number, prefix: string): Tree {
  const bar: SnapshotNode = {
    localId: `${prefix}-root-bar`,
    parentLocalId: null,
    rootKey: "bookmark_bar",
    kind: "folder",
    title: "Bookmarks Bar",
    url: null,
    position: 0,
    dateAdded: 1,
    syncId: null,
    modifiedAt: null,
  };
  const other: SnapshotNode = {
    localId: `${prefix}-root-other`,
    parentLocalId: null,
    rootKey: "other",
    kind: "folder",
    title: "Other Bookmarks",
    url: null,
    position: 1,
    dateAdded: 1,
    syncId: null,
    modifiedAt: null,
  };

  const nodes: SnapshotNode[] = [bar, other];
  const folders: SnapshotNode[] = [bar, other];
  const count = 4 + Math.floor(rng() * 8);

  for (let index = 0; index < count; index += 1) {
    const parent = folders[Math.floor(rng() * folders.length)];
    ensure(parent, "no parent folder available");
    const kind = rng() < 0.35 ? "folder" : "bookmark";
    const position = nodes.filter((node) => node.parentLocalId === parent.localId).length;
    const node: SnapshotNode = {
      localId: `${prefix}-n${index}`,
      parentLocalId: parent.localId,
      rootKey: null,
      kind,
      title: `${prefix}-title-${index}`,
      url: kind === "bookmark" ? `https://${prefix}-${index}.example/` : null,
      position,
      dateAdded: 1_000 + index,
      syncId: null,
      modifiedAt: null,
    };
    nodes.push(node);
    if (kind === "folder") folders.push(node);
  }

  return { roots: ["bookmark_bar", "other"], nodes };
}

function addSharedBookmark(tree: Tree, localId: string, url: string): void {
  const bar = tree.nodes.find((node) => node.rootKey === "bookmark_bar");
  ensure(bar, "bookmark bar missing");
  tree.nodes.push({
    localId,
    parentLocalId: bar.localId,
    rootKey: null,
    kind: "bookmark",
    title: "Shared",
    url,
    position: tree.nodes.filter((node) => node.parentLocalId === bar.localId).length,
    dateAdded: 500,
    syncId: null,
    modifiedAt: null,
  });
}

function makeIdGen(seed: number): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `sync-${seed}-${counter}`;
  };
}

function apply(
  state: CanonicalState,
  endpointId: string,
  tree: Tree,
  newSyncId: () => string,
  previous: EndpointSnapshot | undefined,
  now: number,
) {
  const outcome = mergePush({
    state,
    endpointId,
    push: tree,
    previous,
    newSyncId,
    now,
  });
  const snapshot: EndpointSnapshot = {
    endpointId,
    seqAtCapture: 0,
    capturedAt: now,
    hash: `${endpointId}-${now}`,
    nodes: outcome.snapshotNodes,
  };
  return { outcome, snapshot };
}

function noChanges(outcome: ReturnType<typeof apply>["outcome"]): boolean {
  const counts = outcome.counts;
  return (
    counts.added +
      counts.updated +
      counts.moved +
      counts.deleted +
      counts.resurrected ===
      0 && outcome.changes.length === 0
  );
}

function serializeState(state: CanonicalState): string {
  const nodes = Object.values(state.nodes).sort((left, right) =>
    left.syncId.localeCompare(right.syncId),
  );
  const tombstones = Object.values(state.tombstones).sort((left, right) =>
    left.syncId.localeCompare(right.syncId),
  );
  return JSON.stringify({ nodes, tombstones });
}

function assertStructure(state: CanonicalState): void {
  const nodes = Object.values(state.nodes);
  const ids = new Set(nodes.map((node) => node.syncId));
  ensure(ids.size === nodes.length, "duplicate syncId in canonical state");

  const positionsByParent = new Map<string, number[]>();

  for (const node of nodes) {
    ensure(
      node.kind !== "bookmark" || (node.url !== null && node.url.length > 0),
      `bookmark ${node.syncId} has no url`,
    );
    ensure(
      node.kind !== "folder" || node.url === null,
      `folder ${node.syncId} has a url`,
    );
    ensure(
      Number.isInteger(node.position) && node.position >= 0,
      `node ${node.syncId} has an invalid position`,
    );

    if (node.rootKey) {
      ensure(node.parentSyncId === null, `root ${node.syncId} has a parent`);
      continue;
    }

    ensure(node.parentSyncId !== null, `node ${node.syncId} has no parent`);
    ensure(
      node.parentSyncId !== null && Boolean(state.nodes[node.parentSyncId]),
      `node ${node.syncId} points at a missing parent`,
    );

    if (node.parentSyncId) {
      const list = positionsByParent.get(node.parentSyncId) ?? [];
      list.push(node.position);
      positionsByParent.set(node.parentSyncId, list);
    }
  }

  for (const [parentId, positions] of positionsByParent) {
    const sorted = [...positions].sort((left, right) => left - right);
    sorted.forEach((position, index) => {
      ensure(position === index, `children of ${parentId} are not contiguous`);
    });
  }

  for (const node of nodes) {
    const seen = new Set<string>();
    let current: SyncNode | undefined = node;
    while (current && current.parentSyncId) {
      ensure(!seen.has(current.syncId), `cycle at ${current.syncId}`);
      seen.add(current.syncId);
      current = state.nodes[current.parentSyncId];
    }
  }
}

function assertUnion(state: CanonicalState, trees: Tree[]): void {
  const expectedUrls = new Set<string>();
  for (const tree of trees) {
    for (const node of tree.nodes) {
      if (node.kind === "bookmark" && node.url) expectedUrls.add(node.url);
    }
  }

  for (const url of expectedUrls) {
    const matches = Object.values(state.nodes).filter(
      (node) => node.url === url && !node.deleted,
    );
    ensure(matches.length === 1, `url ${url} has ${matches.length} canonical copies`);
  }
}

function runCase(caseIndex: number): void {
  const rng = mulberry32(caseIndex + 1);
  const treeA = buildTree(rng, `a${caseIndex}`);
  const treeB = buildTree(rng, `b${caseIndex}`);
  const sharedUrl = `https://shared-${caseIndex}.example/`;
  addSharedBookmark(treeA, `a${caseIndex}-shared`, sharedUrl);
  addSharedBookmark(treeB, `b${caseIndex}-shared`, sharedUrl);

  const state = createInitialState();
  const idGen = makeIdGen(caseIndex);

  const a1 = apply(state, "a", treeA, idGen, undefined, 2_000);
  const replayA = apply(state, "a", treeA, idGen, a1.snapshot, 2_500);
  ensure(noChanges(replayA.outcome), "replaying an unchanged tree produced changes");

  const b1 = apply(state, "b", treeB, idGen, undefined, 3_000);
  assertUnion(state, [treeA, treeB]);
  assertStructure(state);

  const shared = Object.values(state.nodes).find(
    (node) => node.url === sharedUrl && !node.deleted,
  );
  ensure(shared, "shared bookmark was not created");

  const sharedLocalA = `a${caseIndex}-shared`;
  const treeAAfterDelete: Tree = {
    roots: treeA.roots,
    nodes: treeA.nodes.filter((node) => node.localId !== sharedLocalA),
  };

  apply(state, "a", treeAAfterDelete, idGen, a1.snapshot, 4_000);
  ensure(state.nodes[shared.syncId]?.deleted === true, "deletion was not applied");
  ensure(Boolean(state.tombstones[shared.syncId]), "tombstone was not created");

  apply(state, "b", treeB, idGen, b1.snapshot, 5_000);
  ensure(
    state.nodes[shared.syncId]?.deleted === true,
    "a stale endpoint resurrected a deleted bookmark",
  );

  // Determinism: the same sequence on a fresh state must produce identical data.
  const state2 = createInitialState();
  const idGen2 = makeIdGen(caseIndex);
  const a1b = apply(state2, "a", treeA, idGen2, undefined, 2_000);
  apply(state2, "a", treeA, idGen2, a1b.snapshot, 2_500);
  const b1b = apply(state2, "b", treeB, idGen2, undefined, 3_000);
  apply(state2, "a", treeAAfterDelete, idGen2, a1b.snapshot, 4_000);
  apply(state2, "b", treeB, idGen2, b1b.snapshot, 5_000);

  ensure(
    serializeState(state) === serializeState(state2),
    "merge result is not deterministic",
  );
}

describe("merge invariants", () => {
  it(`holds union, structure, tombstone, idempotency and determinism over ${CASES} random cases`, () => {
    for (let caseIndex = 0; caseIndex < CASES; caseIndex += 1) {
      try {
        runCase(caseIndex);
      } catch (error) {
        throw new Error(
          `case ${caseIndex} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }, 120_000);
});
