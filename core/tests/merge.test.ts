import { beforeEach, describe, expect, it } from "vitest";
import { mergePush } from "../src/merge";
import { createInitialState } from "../src/state";
import type { CanonicalState, RootKey, SnapshotNode } from "../src/model";

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
      parentLocalId: null,
      rootKey: "bookmark_bar",
      kind: "folder",
      title: "Bookmarks Bar",
      position: 0,
    }),
    makeNode({
      localId: "2",
      parentLocalId: null,
      rootKey: "other",
      kind: "folder",
      title: "Other Bookmarks",
      position: 1,
    }),
  ];
}

function push(
  state: CanonicalState,
  endpointId: string,
  nodes: SnapshotNode[],
  previous?: Parameters<typeof mergePush>[0]["previous"],
) {
  return mergePush({
    state,
    endpointId,
    push: { roots: ["bookmark_bar", "other"], nodes: [...rootNodes(), ...nodes] },
    previous,
    newSyncId,
    now: 2_000,
  });
}

function bookmarksByUrl(state: CanonicalState, url: string) {
  return Object.values(state.nodes).filter((node) => node.url === url);
}

describe("mergePush — US1 union semantics", () => {
  it("keeps additions from both endpoints", () => {
    const state = createInitialState();

    const first = push(state, "chrome", [
      makeNode({
        localId: "10",
        parentLocalId: "1",
        title: "A",
        url: "https://a.example/",
        position: 0,
      }),
    ]);
    expect(first.counts.added).toBe(1);

    const second = push(state, "ego", [
      makeNode({
        localId: "20",
        parentLocalId: "1",
        title: "B",
        url: "https://b.example/",
        position: 0,
      }),
    ]);
    expect(second.counts.added).toBe(1);

    expect(bookmarksByUrl(state, "https://a.example/")).toHaveLength(1);
    expect(bookmarksByUrl(state, "https://b.example/")).toHaveLength(1);
  });

  it("merges identical content from two endpoints into one canonical node", () => {
    const state = createInitialState();

    const first = push(state, "chrome", [
      makeNode({
        localId: "10",
        parentLocalId: "1",
        title: "Shared",
        url: "https://shared.example/",
        position: 0,
      }),
    ]);
    const sharedId = first.snapshotNodes.find((node) => node.localId === "10")?.syncId;
    expect(sharedId).toBeTruthy();

    const second = push(state, "ego", [
      makeNode({
        localId: "20",
        parentLocalId: "1",
        title: "Shared",
        url: "https://shared.example/",
        position: 0,
      }),
    ]);

    expect(second.counts.added).toBe(0);
    const binding = second.bindings.find((entry) => entry.localId === "20");
    expect(binding?.syncId).toBe(sharedId);
    expect(bookmarksByUrl(state, "https://shared.example/")).toHaveLength(1);
  });

  it("keeps the same URL in different folders as two bookmarks", () => {
    const state = createInitialState();

    push(state, "chrome", [
      makeNode({
        localId: "10",
        parentLocalId: "1",
        title: "Same",
        url: "https://same.example/",
        position: 0,
      }),
    ]);
    push(state, "ego", [
      makeNode({
        localId: "20",
        parentLocalId: "2",
        title: "Same",
        url: "https://same.example/",
        position: 0,
      }),
    ]);

    expect(bookmarksByUrl(state, "https://same.example/")).toHaveLength(2);
  });

  it("returns bindings for roots and new nodes on first push", () => {
    const state = createInitialState();
    const outcome = push(state, "chrome", [
      makeNode({
        localId: "10",
        parentLocalId: "1",
        title: "Bound",
        url: "https://bound.example/",
        position: 0,
      }),
    ]);

    const localIds = outcome.bindings.map((entry) => entry.localId).sort();
    expect(localIds).toEqual(["1", "10", "2"]);
  });

  it("updates a known syncId when the title changes", () => {
    const state = createInitialState();
    const first = push(state, "chrome", [
      makeNode({
        localId: "10",
        parentLocalId: "1",
        title: "Old",
        url: "https://rename.example/",
        position: 0,
      }),
    ]);
    const syncId = first.snapshotNodes.find((node) => node.localId === "10")?.syncId;
    expect(syncId).toBeTruthy();

    const second = push(state, "chrome", [
      makeNode({
        localId: "10",
        parentLocalId: "1",
        title: "New",
        url: "https://rename.example/",
        position: 0,
        syncId,
        modifiedAt: 3_000,
      }),
    ]);

    expect(second.counts.updated).toBe(1);
    const canonical = state.nodes[syncId as string];
    expect(canonical?.title).toBe("New");
    expect(second.changes[0]?.payload.title).toBe("New");
  });

  it("never assigns the same syncId to two canonical nodes", () => {
    const state = createInitialState();
    push(state, "chrome", [
      makeNode({ localId: "10", parentLocalId: "1", title: "One", url: "https://one.example/" }),
      makeNode({ localId: "11", parentLocalId: "1", title: "Two", url: "https://two.example/" }),
    ]);
    push(state, "ego", [
      makeNode({ localId: "20", parentLocalId: "1", title: "Three", url: "https://three.example/" }),
    ]);

    const ids = Object.keys(state.nodes);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
