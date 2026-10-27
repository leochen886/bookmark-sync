import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/state-store";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bookmark-sync-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("StateStore", () => {
  it("rejects a malformed node instead of crashing on startup", async () => {
    const dir = await tempDir();
    const malformed = {
      schemaVersion: 1,
      seq: 0,
      nodes: {
        broken: {
          parentSyncId: "root:bookmark_bar",
          kind: "bookmark",
          position: 0,
          deleted: false,
        },
      },
      tombstones: {},
      endpoints: {},
      snapshots: {},
      changes: [],
    };
    await writeFile(join(dir, "state.json"), JSON.stringify(malformed), "utf8");

    const store = await StateStore.open({ dataDir: dir });
    const state = store.getState();

    expect(state.nodes.broken).toBeUndefined();
    expect(state.nodes["root:bookmark_bar"]).toBeDefined();
    expect(state.nodes["root:other"]).toBeDefined();

    const files = await readdir(dir);
    expect(files.some((name) => name.startsWith("state.corrupt-"))).toBe(true);
  });
});
