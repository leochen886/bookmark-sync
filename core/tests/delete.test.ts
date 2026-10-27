import { beforeEach, describe, expect, it } from "vitest";
import { mergePush } from "../src/merge";
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
  modifiedAt?: number | null;
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
    modifiedAt: input.modifiedAt ?? null,
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

function syncIdOf(snapshot: EndpointSnapshot, localId: string): string {
  const node = snapshot.nodes.find((candidate) => candidate.localId === localId);
  if (!node?.syncId) throw new Error(`no syncId for local ${localId}`);
  return node.syncId;
}

function sharedBookmark(): SnapshotNode {
  return makeNode({
    localId: "10",
    parentLocalId: "1",
    title: "Shared",
    url: "https://shared.example/",
  });
}

describe("mergePush — US2 deletions", () => {
  it("tombstones a bookmark the endpoint no longer reports", () => {
    const state = createInitialState();
    const first = push(state, "chrome", [sharedBookmark()]);
    push(state, "ego", [sharedBookmark()]);

    const syncId = syncIdOf(first.snapshot, "10");
    const afterDelete = push(state, "chrome", [], first.snapshot);

    expect(afterDelete.outcome.counts.deleted).toBe(1);
    expect(afterDelete.outcome.tombstones).toHaveLength(1);
    expect(afterDelete.outcome.changes.some((change) => change.type === "delete")).toBe(true);
    expect(state.nodes[syncId]?.deleted).toBe(true);
    expect(state.tombstones[syncId]).toBeDefined();
  });

  it("does not resurrect a deleted node for a stale endpoint", () => {
    const state = createInitialState();
    const first = push(state, "chrome", [sharedBookmark()]);
    const egoFirst = push(state, "ego", [sharedBookmark()]);
    const syncId = syncIdOf(first.snapshot, "10");

    push(state, "chrome", [], first.snapshot);

    const stale = egoFirst.snapshot.nodes.find((node) => node.localId === "10");
    expect(stale).toBeDefined();
    const egoAgain = push(state, "ego", [{ ...stale! }], egoFirst.snapshot);

    expect(egoAgain.outcome.counts.resurrected).toBe(0);
    expect(state.nodes[syncId]?.deleted).toBe(true);
    expect(state.tombstones[syncId]).toBeDefined();
  });

  it("deletes a bookmark when the delete arrives after another endpoint edited it", () => {
    const state = createInitialState();
    const chromeFirst = push(state, "chrome", [sharedBookmark()]);
    const egoFirst = push(state, "ego", [sharedBookmark()]);
    const syncId = syncIdOf(chromeFirst.snapshot, "10");

    const egoEdit = egoFirst.snapshot.nodes.find((node) => node.localId === "10");
    expect(egoEdit).toBeDefined();
    push(state, "ego", [{ ...egoEdit!, title: "Edited", modifiedAt: 3_000 }], egoFirst.snapshot);
    expect(state.nodes[syncId]?.title).toBe("Edited");

    const chromeDelete = push(state, "chrome", [], chromeFirst.snapshot);

    // Two-way mirror: the later event wins.
    expect(chromeDelete.outcome.counts.deleted).toBe(1);
    expect(chromeDelete.outcome.conflicts).toHaveLength(1);
    expect(chromeDelete.outcome.conflicts[0]?.kind).toBe("delete_vs_edit");
    expect(chromeDelete.outcome.conflicts[0]?.resolution).toBe("delete_wins");
    expect(state.nodes[syncId]?.deleted).toBe(true);
    expect(state.tombstones[syncId]).toBeDefined();
  });

  it("deletes a folder subtree parent-first with parent_delete tombstones", () => {
    const state = createInitialState();
    const folder = makeNode({
      localId: "10",
      parentLocalId: "1",
      kind: "folder",
      title: "Folder",
    });
    const child = makeNode({
      localId: "11",
      parentLocalId: "10",
      title: "Child",
      url: "https://child.example/",
    });

    const first = push(state, "chrome", [folder, child]);
    const folderSyncId = syncIdOf(first.snapshot, "10");
    const childSyncId = syncIdOf(first.snapshot, "11");

    const afterDelete = push(state, "chrome", [], first.snapshot);

    expect(afterDelete.outcome.counts.deleted).toBe(2);
    const deleteChanges = afterDelete.outcome.changes.filter(
      (change) => change.type === "delete",
    );
    expect(deleteChanges.map((change) => change.syncId)).toEqual([
      folderSyncId,
      childSyncId,
    ]);
    expect(state.tombstones[folderSyncId]?.reason).toBe("user_delete");
    expect(state.tombstones[childSyncId]?.reason).toBe("parent_delete");
    expect(state.nodes[folderSyncId]?.deleted).toBe(true);
    expect(state.nodes[childSyncId]?.deleted).toBe(true);
  });

  it("resurrects a deleted bookmark when another endpoint edits it", () => {
    const state = createInitialState();
    const chromeFirst = push(state, "chrome", [sharedBookmark()]);
    const egoFirst = push(state, "ego", [sharedBookmark()]);
    const syncId = syncIdOf(chromeFirst.snapshot, "10");

    push(state, "chrome", [], chromeFirst.snapshot);

    const egoNode = egoFirst.snapshot.nodes.find((node) => node.localId === "10");
    expect(egoNode).toBeDefined();
    const resurrect = push(
      state,
      "ego",
      [{ ...egoNode!, title: "Restored", modifiedAt: 4_000 }],
      egoFirst.snapshot,
    );

    expect(resurrect.outcome.counts.resurrected).toBe(1);
    expect(resurrect.outcome.conflicts[0]?.resolution).toBe("keep_modified");
    expect(resurrect.outcome.changes.some((change) => change.type === "undelete")).toBe(true);
    expect(state.nodes[syncId]?.deleted).toBe(false);
    expect(state.nodes[syncId]?.title).toBe("Restored");
  });
});
