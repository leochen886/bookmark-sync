import { describe, expect, it } from "vitest";
import {
  createInitialState,
  type Endpoint,
  type SyncNode,
} from "@bookmark-sync/core";
import { pruneTombstones } from "../src/session";

const DAY = 24 * 60 * 60 * 1000;

function endpoint(id: string, lastSeq: number): Endpoint {
  return {
    endpointId: id,
    browser: "chrome",
    profileLabel: id,
    tokenHash: "hash",
    lastSeq,
    lastSeenAt: 0,
    lastSnapshotHash: null,
    status: "offline",
  };
}

function deletedNode(id: string): SyncNode {
  return {
    syncId: id,
    kind: "bookmark",
    title: "Deleted",
    url: "https://deleted.example/",
    parentSyncId: "root:bookmark_bar",
    rootKey: null,
    position: 0,
    createdAt: 0,
    modifiedAt: 0,
    origin: "a",
    rev: 2,
    deleted: true,
    deletedAt: 0,
    contentKey: "key",
  };
}

describe("pruneTombstones", () => {
  it("drops a tombstone once every endpoint acknowledged it and retention elapsed", () => {
    const state = createInitialState();
    const now = 40 * DAY;
    state.endpoints = { a: endpoint("a", 5), b: endpoint("b", 7) };
    state.nodes.deleted = deletedNode("deleted");
    state.tombstones.deleted = {
      syncId: "deleted",
      deletedAt: now - 31 * DAY,
      origin: "a",
      seq: 3,
      reason: "user_delete",
    };

    expect(pruneTombstones(state, now)).toBe(1);
    expect(state.tombstones.deleted).toBeUndefined();
    expect(state.nodes.deleted).toBeUndefined();
  });

  it("keeps a tombstone while an endpoint has not acknowledged the delete", () => {
    const state = createInitialState();
    const now = 40 * DAY;
    state.endpoints = { a: endpoint("a", 5), b: endpoint("b", 2) };
    state.nodes.deleted = deletedNode("deleted");
    state.tombstones.deleted = {
      syncId: "deleted",
      deletedAt: now - 31 * DAY,
      origin: "a",
      seq: 3,
      reason: "user_delete",
    };

    expect(pruneTombstones(state, now)).toBe(0);
    expect(state.tombstones.deleted).toBeDefined();
  });

  it("keeps a tombstone inside the retention window", () => {
    const state = createInitialState();
    const now = 40 * DAY;
    state.endpoints = { a: endpoint("a", 5) };
    state.nodes.deleted = deletedNode("deleted");
    state.tombstones.deleted = {
      syncId: "deleted",
      deletedAt: now - 10 * DAY,
      origin: "a",
      seq: 3,
      reason: "user_delete",
    };

    expect(pruneTombstones(state, now)).toBe(0);
    expect(state.nodes.deleted).toBeDefined();
  });
});
