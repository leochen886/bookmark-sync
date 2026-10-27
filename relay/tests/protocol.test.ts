import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SnapshotNode } from "@bookmark-sync/core";
import { PROTOCOL_VERSION } from "@bookmark-sync/core/protocol";
import { startRelay, type RelayHandle } from "../src/server";

interface AnyMessage {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

class TestClient {
  private readonly inbox: AnyMessage[] = [];
  private readonly waiters: Array<(message: AnyMessage) => void> = [];

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as AnyMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.inbox.push(message);
    });
  }

  static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new TestClient(socket);
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), ...message }));
  }

  next(timeoutMs = 5_000): Promise<AnyMessage> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a relay message")), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  async nextFor(requestId: string, timeoutMs = 5_000): Promise<AnyMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const message = await this.next(deadline - Date.now());
      if (message.requestId === requestId) return message;
    }
    throw new Error(`no response for request ${requestId}`);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // ignore
    }
  }

  waitForClose(timeoutMs = 5_000): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
      this.socket.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}

let relay: RelayHandle | null = null;
let dataDir: string | null = null;
const clients: TestClient[] = [];

function rootNodes(): SnapshotNode[] {
  return [
    {
      localId: "1",
      parentLocalId: null,
      rootKey: "bookmark_bar",
      kind: "folder",
      title: "Bookmarks Bar",
      url: null,
      position: 0,
      dateAdded: 1,
    },
    {
      localId: "2",
      parentLocalId: null,
      rootKey: "other",
      kind: "folder",
      title: "Other Bookmarks",
      url: null,
      position: 1,
      dateAdded: 1,
    },
  ];
}

function bookmark(
  localId: string,
  parentLocalId: string,
  title: string,
  url: string,
): SnapshotNode {
  return {
    localId,
    parentLocalId,
    rootKey: null,
    kind: "bookmark",
    title,
    url,
    position: 0,
    dateAdded: Date.now(),
  };
}

async function connect(endpointId: string): Promise<TestClient> {
  if (!relay) throw new Error("relay not started");
  const client = await TestClient.connect(relay.port);
  clients.push(client);
  const [installId, browser, profileLabel] = endpointId.split(":");
  client.send({
    type: "hello",
    requestId: "hello",
    endpointId,
    installId,
    browser,
    profileLabel,
    clientVersion: "test",
    token: relay.token,
    lastSeq: 0,
  });
  const welcome = await client.nextFor("hello");
  expect(welcome.type).toBe("welcome");
  return client;
}

async function previewAndCommit(
  client: TestClient,
  endpointId: string,
  nodes: SnapshotNode[],
): Promise<AnyMessage> {
  const pushRequestId = `push-${endpointId}`;
  client.send({
    type: "push",
    requestId: pushRequestId,
    baseSeq: 0,
    snapshotHash: `hash-${endpointId}`,
    dryRun: true,
    snapshot: { roots: ["bookmark_bar", "other"], nodes: [...rootNodes(), ...nodes] },
  });
  const preview = await client.nextFor(pushRequestId);
  expect(preview.type).toBe("push-result");
  expect(preview.dryRun).toBe(true);

  const commitRequestId = `commit-${endpointId}`;
  client.send({
    type: "commit",
    requestId: commitRequestId,
    previewRequestId: pushRequestId,
    snapshotHash: `hash-${endpointId}`,
  });
  const committed = await client.nextFor(commitRequestId);
  expect(committed.type).toBe("push-result");
  expect(committed.dryRun).toBe(false);
  return committed;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "bookmark-sync-relay-"));
  relay = await startRelay({ port: 0, dataDir });
}, 15_000);

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  if (relay) await relay.close();
  relay = null;
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  dataDir = null;
}, 15_000);

describe("relay protocol — US1 push/pull", () => {
  it("previews, commits, and returns the addition through pull", async () => {
    const client = await connect("install-a:chrome:test");

    const pushRequestId = "push-a";
    client.send({
      type: "push",
      requestId: pushRequestId,
      baseSeq: 0,
      snapshotHash: "hash-a",
      dryRun: true,
      snapshot: {
        roots: ["bookmark_bar", "other"],
        nodes: [
          ...rootNodes(),
          bookmark("10", "1", "Alpha", "https://alpha.example/"),
        ],
      },
    });

    const preview = await client.nextFor(pushRequestId);
    expect(preview.type).toBe("push-result");
    expect(preview.dryRun).toBe(true);
    expect((preview.counts as { added: number }).added).toBe(1);
    expect((preview.bindings as unknown[]).length).toBeGreaterThanOrEqual(3);

    const commitRequestId = "commit-a";
    client.send({
      type: "commit",
      requestId: commitRequestId,
      previewRequestId: pushRequestId,
      snapshotHash: "hash-a",
    });
    const committed = await client.nextFor(commitRequestId);
    expect(committed.type).toBe("push-result");
    expect(committed.applied).toBe(true);
    expect(typeof committed.seq).toBe("number");

    client.send({ type: "pull", requestId: "pull-a", sinceSeq: 0 });
    const ops = await client.nextFor("pull-a");
    expect(ops.type).toBe("ops");
    const changes = ops.changes as Array<{ type: string; payload: { title?: string } }>;
    expect(changes).toHaveLength(1);
    expect(changes[0]?.type).toBe("add");
    expect(changes[0]?.payload.title).toBe("Alpha");

    client.send({ type: "ack", seq: ops.seq as number });
  }, 15_000);

  it("unions additions from two endpoints", async () => {
    const chrome = await connect("install-a:chrome:test");
    await previewAndCommit(chrome, "a", [
      bookmark("10", "1", "Alpha", "https://alpha.example/"),
    ]);

    const ego = await connect("install-b:ego:test");
    const egoResult = await previewAndCommit(ego, "b", [
      bookmark("20", "1", "Beta", "https://beta.example/"),
    ]);
    expect(egoResult.applied).toBe(true);

    ego.send({ type: "resync", requestId: "resync-b" });
    const snapshot = await ego.nextFor("resync-b");
    expect(snapshot.type).toBe("snapshot");
    const titles = (snapshot.nodes as Array<{ title: string }>).map((node) => node.title);
    expect(titles).toContain("Alpha");
    expect(titles).toContain("Beta");
  }, 15_000);

  it("rejects an invalid token and closes with 4401", async () => {
    if (!relay) throw new Error("relay not started");
    const client = await TestClient.connect(relay.port);
    clients.push(client);
    const closeCode = client.waitForClose();

    client.send({
      type: "hello",
      requestId: "bad-hello",
      endpointId: "install-bad:chrome:test",
      installId: "install-bad",
      browser: "chrome",
      profileLabel: "test",
      clientVersion: "test",
      token: "definitely-not-the-token",
      lastSeq: 0,
    });

    const error = await client.nextFor("bad-hello");
    expect(error.type).toBe("error");
    expect(error.code).toBe("AUTH_FAILED");
    expect(await closeCode).toBe(4401);
  }, 15_000);

  it("rejects a mismatched commit hash", async () => {
    const client = await connect("install-c:chrome:test");
    client.send({
      type: "push",
      requestId: "push-c",
      baseSeq: 0,
      snapshotHash: "hash-c",
      dryRun: true,
      snapshot: {
        roots: ["bookmark_bar", "other"],
        nodes: [...rootNodes(), bookmark("30", "1", "Gamma", "https://gamma.example/")],
      },
    });
    const preview = await client.nextFor("push-c");
    expect(preview.type).toBe("push-result");

    client.send({
      type: "commit",
      requestId: "commit-c",
      previewRequestId: "push-c",
      snapshotHash: "different-hash",
    });
    const error = await client.nextFor("commit-c");
    expect(error.type).toBe("error");
    expect(error.code).toBe("HASH_MISMATCH");
  }, 15_000);
});
