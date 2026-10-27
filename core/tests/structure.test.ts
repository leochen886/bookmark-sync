import { beforeEach, describe, expect, it } from "vitest";
import {
  mergePush,
  validatePushSnapshot,
  wouldCreateCycle,
} from "../src/merge";
import { diffSnapshot } from "../src/diff";
import { contentKey } from "../src/identity";
import { createInitialState } from "../src/state";
import type {
  CanonicalState,
  EndpointSnapshot,
  RootKey,
  SnapshotNode,
} from "../src/model";

let counter = 0;

function newSyncId(): string {
  counter += 1;
  return `sync-${counter}`;
}

beforeEach(() => {
  counter = 0;
});

interface NodeInput {
  localId: string;
  title: string;
  parentLocalId?: string | null;
  rootKey?: RootKey | null;
  kind?: "bookmark" | "folder";
  url?: string | null;
  position?: number;
  dateAdded?: number;
  syncId?: string | null;
}

function makeNode(input: NodeInput): SnapshotNode {
  const kind = input.kind ?? "bookmark";
  return {
    localId: input.localId,
    parentLocalId: input.parentLocalId ?? null,
    rootKey: input.rootKey ?? null,
    kind,
    title: input.title,
    url: kind === "folder" ? null : (input.url ?? "https://example.com/"),
    position: input.position ?? 0,
    dateAdded: input.dateAdded ?? 1_000,
    syncId: input.syncId ?? null,
    modifiedAt: null,
  };
}

function rootNodes(): SnapshotNode[] {
  return [
    makeNode({
      localId: "1",
      rootKey: "bookmark_bar",
      kind: "folder",
      title: "Bookmarks Bar",
    }),
    makeNode({ localId: "2", rootKey: "other", kind: "folder", title: "Other Bookmarks" }),
  ];
}

function push(
  state: CanonicalState,
  endpointId: string,
  nodes: SnapshotNode[],
  previous?: EndpointSnapshot,
) {
  const outcome = mergePush({
    state,
    endpointId,
    push: { roots: ["bookmark_bar", "other"], nodes: [...rootNodes(), ...nodes] },
    previous,
    newSyncId,
    now: 2_000,
  });
  const snapshot: EndpointSnapshot = {
    endpointId,
    seqAtCapture: 0,
    capturedAt: 2_000,
    hash: `${endpointId}-${counter}`,
    nodes: outcome.snapshotNodes,
  };
  return { outcome, snapshot };
}

function withSync(
  snapshot: EndpointSnapshot,
  localId: string,
  overrides: Partial<SnapshotNode> = {},
): SnapshotNode {
  const node = snapshot.nodes.find((candidate) => candidate.localId === localId);
  if (!node) throw new Error(`no snapshot node for local ${localId}`);
  return { ...node, ...overrides };
}

function syncIdOf(snapshot: EndpointSnapshot, localId: string): string {
  const node = snapshot.nodes.find((candidate) => candidate.localId === localId);
  if (!node?.syncId) throw new Error(`no syncId for local ${localId}`);
  return node.syncId;
}

function byTitle(state: CanonicalState, title: string) {
  return Object.values(state.nodes).find((node) => node.title === title);
}

describe("mergePush — US3 structure", () => {
  it("preserves a three-level folder hierarchy", () => {
    const state = createInitialState();
    const { snapshot } = push(state, "chrome", [
      makeNode({ localId: "10", parentLocalId: "1", kind: "folder", title: "Work" }),
      makeNode({ localId: "11", parentLocalId: "10", kind: "folder", title: "Project" }),
      makeNode({
        localId: "12",
        parentLocalId: "11",
        title: "Deep",
        url: "https://deep.example/",
      }),
    ]);

    const work = byTitle(state, "Work");
    const project = byTitle(state, "Project");
    const deep = byTitle(state, "Deep");

    expect(work?.parentSyncId).toBe("root:bookmark_bar");
    expect(project?.parentSyncId).toBe(syncIdOf(snapshot, "10"));
    expect(deep?.parentSyncId).toBe(syncIdOf(snapshot, "11"));
  });

  it("propagates a bookmark move without creating a duplicate", () => {
    const state = createInitialState();
    const first = push(state, "chrome", [
      makeNode({ localId: "10", parentLocalId: "1", kind: "folder", title: "Folder" }),
      makeNode({
        localId: "11",
        parentLocalId: "1",
        title: "Move me",
        url: "https://move.example/",
      }),
    ]);

    const folderSyncId = syncIdOf(first.snapshot, "10");
    const bookmarkSyncId = syncIdOf(first.snapshot, "11");

    const second = push(
      state,
      "chrome",
      [
        withSync(first.snapshot, "10"),
        withSync(first.snapshot, "11", { parentLocalId: "10" }),
      ],
      first.snapshot,
    );

    expect(second.outcome.counts.moved).toBe(1);
    expect(state.nodes[bookmarkSyncId]?.parentSyncId).toBe(folderSyncId);
    expect(
      Object.values(state.nodes).filter((node) => node.url === "https://move.example/"),
    ).toHaveLength(1);
    expect(second.outcome.changes.some((change) => change.type === "move")).toBe(true);
  });

  it("renames a folder and refreshes descendant content keys", () => {
    const state = createInitialState();
    const first = push(state, "chrome", [
      makeNode({ localId: "10", parentLocalId: "1", kind: "folder", title: "Old" }),
      makeNode({
        localId: "11",
        parentLocalId: "10",
        title: "Child",
        url: "https://child.example/",
      }),
    ]);

    const childSyncId = syncIdOf(first.snapshot, "11");
    const before = state.nodes[childSyncId]?.contentKey;
    expect(before).toBeTruthy();

    const second = push(
      state,
      "chrome",
      [
        withSync(first.snapshot, "10", { title: "Archive" }),
        withSync(first.snapshot, "11"),
      ],
      first.snapshot,
    );

    expect(second.outcome.counts.updated).toBe(1);
    expect(byTitle(state, "Archive")).toBeDefined();
    expect(state.nodes[childSyncId]?.contentKey).not.toBe(before);
    expect(state.nodes[childSyncId]?.contentKey).toBe(
      contentKey("bookmark_bar/Archive", "Child", "https://child.example/"),
    );
  });

  it("detects moves that would create a folder cycle", () => {
    const state = createInitialState();
    const { snapshot } = push(state, "chrome", [
      makeNode({ localId: "10", parentLocalId: "1", kind: "folder", title: "A" }),
      makeNode({ localId: "11", parentLocalId: "10", kind: "folder", title: "B" }),
    ]);

    const a = syncIdOf(snapshot, "10");
    const b = syncIdOf(snapshot, "11");

    expect(wouldCreateCycle(state, a, b)).toBe(true);
    expect(wouldCreateCycle(state, a, a)).toBe(true);
    expect(wouldCreateCycle(state, a, "root:bookmark_bar")).toBe(false);
    expect(wouldCreateCycle(state, b, a)).toBe(false);
  });

  it("normalizes sibling positions to a contiguous range", () => {
    const state = createInitialState();
    push(state, "chrome", [
      makeNode({
        localId: "10",
        parentLocalId: "1",
        title: "Five",
        url: "https://five.example/",
        position: 5,
      }),
      makeNode({
        localId: "11",
        parentLocalId: "1",
        title: "Two",
        url: "https://two.example/",
        position: 2,
      }),
    ]);

    expect(byTitle(state, "Two")?.position).toBe(0);
    expect(byTitle(state, "Five")?.position).toBe(1);
  });

  it("reports a parent change as a move in the snapshot diff", () => {
    const before = makeNode({
      localId: "10",
      parentLocalId: "1",
      title: "Move me",
      url: "https://move.example/",
    });
    const after = { ...before, parentLocalId: "20" };

    const diff = diffSnapshot([before], [after]);
    expect(diff.moved).toHaveLength(1);
    expect(diff.updated).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("rejects a batch that repeats a syncId", () => {
    const nodes = [
      makeNode({ localId: "10", title: "One", syncId: "duplicate" }),
      makeNode({ localId: "11", title: "Two", syncId: "duplicate" }),
    ];
    expect(validatePushSnapshot(nodes)).toContain("duplicate syncId");

    const distinct = [
      makeNode({ localId: "10", title: "One", syncId: "one" }),
      makeNode({ localId: "11", title: "Two", syncId: "two" }),
    ];
    expect(validatePushSnapshot(distinct)).toBeNull();
  });
});
