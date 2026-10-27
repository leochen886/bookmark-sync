import { describe, expect, it } from "vitest";
import { mergePush } from "@bookmark-sync/core";
import type { SnapshotNode } from "@bookmark-sync/core";
import { createInitialState } from "@bookmark-sync/core";

const BOOKMARK_COUNT = 1_000;
const FOLDER_DEPTH = 5;
const BUDGET_MS = 60_000;

interface Tree {
  roots: ["bookmark_bar", "other"];
  nodes: SnapshotNode[];
}

function buildTree(prefix: string): Tree {
  const bar: SnapshotNode = {
    localId: `${prefix}-bar`,
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
    localId: `${prefix}-other`,
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
  let parentId = bar.localId;

  for (let level = 1; level <= FOLDER_DEPTH; level += 1) {
    const folder: SnapshotNode = {
      localId: `${prefix}-folder-${level}`,
      parentLocalId: parentId,
      rootKey: null,
      kind: "folder",
      title: `Level ${level}`,
      url: null,
      position: 0,
      dateAdded: 10 + level,
      syncId: null,
      modifiedAt: null,
    };
    nodes.push(folder);
    parentId = folder.localId;
  }

  for (let index = 0; index < BOOKMARK_COUNT; index += 1) {
    nodes.push({
      localId: `${prefix}-bookmark-${index}`,
      parentLocalId: parentId,
      rootKey: null,
      kind: "bookmark",
      title: `Bookmark ${index}`,
      url: `https://scale.example/${index}`,
      position: index,
      dateAdded: 1_000 + index,
      syncId: null,
      modifiedAt: null,
    });
  }

  return { roots: ["bookmark_bar", "other"], nodes };
}

function makeIdGen(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `scale-sync-${counter}`;
  };
}

describe("scale", () => {
  it(
    `merges ${BOOKMARK_COUNT} bookmarks across ${FOLDER_DEPTH} folder levels within ${BUDGET_MS} ms`,
    () => {
      const state = createInitialState();
      const treeA = buildTree("a");
      const treeB = buildTree("b");
      const idGenA = makeIdGen();

      const startA = performance.now();
      const first = mergePush({
        state,
        endpointId: "a",
        push: treeA,
        newSyncId: idGenA,
        now: 1_000,
      });
      const durationA = performance.now() - startA;

      expect(first.counts.added).toBe(BOOKMARK_COUNT + FOLDER_DEPTH);
      expect(first.counts.conflicts).toBe(0);
      expect(durationA).toBeLessThan(BUDGET_MS);

      const bookmarks = Object.values(state.nodes).filter(
        (node) => node.kind === "bookmark" && node.url?.startsWith("https://scale.example/"),
      );
      expect(bookmarks).toHaveLength(BOOKMARK_COUNT);

      // Every bookmark sits below all five folder levels.
      for (const bookmark of bookmarks.slice(0, 50)) {
        let depth = 0;
        let current = bookmark;
        const seen = new Set<string>();
        while (current.parentSyncId) {
          expect(seen.has(current.syncId)).toBe(false);
          seen.add(current.syncId);
          depth += 1;
          const parent = state.nodes[current.parentSyncId];
          expect(parent).toBeDefined();
          if (!parent) break;
          current = parent;
        }
        expect(depth).toBe(FOLDER_DEPTH + 1);
      }

      const idGenB = makeIdGen();
      const startB = performance.now();
      const second = mergePush({
        state,
        endpointId: "b",
        push: treeB,
        newSyncId: idGenB,
        now: 2_000,
      });
      const durationB = performance.now() - startB;

      expect(second.counts.added).toBe(0);
      expect(second.counts.conflicts).toBe(0);
      expect(durationB).toBeLessThan(BUDGET_MS);

      const urls = new Set(
        Object.values(state.nodes)
          .filter((node) => node.url?.startsWith("https://scale.example/"))
          .map((node) => node.url),
      );
      expect(urls.size).toBe(BOOKMARK_COUNT);

      console.log(
        `scale: first=${durationA.toFixed(0)}ms second=${durationB.toFixed(0)}ms nodes=${Object.keys(state.nodes).length}`,
      );
    },
    120_000,
  );
});
