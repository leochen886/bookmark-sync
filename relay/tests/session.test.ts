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

  async nextFor(requestId: string, timeoutMs = 5_000): Promise<AnyMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const message = await this.next(deadline - Date.now());
      if (message.requestId === requestId) return message;
    }
    throw new Error(`no response for ${requestId}`);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // ignore
    }
  }

  private next(timeoutMs: number): Promise<AnyMessage> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for relay message")),
        timeoutMs,
      );
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
}

let relay: RelayHandle | null = null;
let dataDir: string | null = null;
let client: TestClient | null = null;

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

function snapshotWithBookmark(): { roots: ["bookmark_bar", "other"]; nodes: SnapshotNode[] } {
  return {
    roots: ["bookmark_bar", "other"],
    nodes: [
      ...rootNodes(),
      {
        localId: "10",
        parentLocalId: "1",
        rootKey: null,
        kind: "bookmark",
        title: "Idempotent",
        url: "https://idempotent.example/",
        position: 0,
        dateAdded: 1_000,
        syncId: null,
      },
    ],
  };
}

async function connect(lastSeq = 0): Promise<TestClient> {
  if (!relay) throw new Error("relay not started");
  const socket = await TestClient.connect(relay.port);
  client = socket;
  socket.send({
    type: "hello",
    requestId: "hello",
    endpointId: "install-s:chrome:test",
    installId: "install-s",
    browser: "chrome",
    profileLabel: "test",
    clientVersion: "test",
    token: relay.token,
    lastSeq,
  });
  const welcome = await socket.nextFor("hello");
  expect(welcome.type).toBe("welcome");
  return socket;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "bookmark-sync-session-"));
  relay = await startRelay({ port: 0, dataDir });
}, 15_000);

afterEach(async () => {
  client?.close();
  client = null;
  if (relay) await relay.close();
  relay = null;
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  dataDir = null;
}, 15_000);

describe("relay session — idempotency and replay", () => {
  it("does not advance seq for a duplicate push and replays unacked changes", async () => {
    const socket = await connect();

    socket.send({
      type: "push",
      requestId: "push-1",
      baseSeq: 0,
      snapshotHash: "stable-hash",
      snapshot: snapshotWithBookmark(),
    });
    const first = await socket.nextFor("push-1");
    expect(first.type).toBe("push-result");
    expect(first.applied).toBe(true);
    expect(first.seq).toBe(1);

    socket.send({
      type: "push",
      requestId: "push-2",
      baseSeq: 0,
      snapshotHash: "stable-hash",
      snapshot: snapshotWithBookmark(),
    });
    const second = await socket.nextFor("push-2");
    expect(second.type).toBe("push-result");
    expect(second.applied).toBe(false);
    expect(second.seq).toBe(1);

    socket.send({ type: "pull", requestId: "pull-1", sinceSeq: 0 });
    const firstReplay = await socket.nextFor("pull-1");
    expect(firstReplay.type).toBe("ops");
    expect((firstReplay.changes as unknown[]).length).toBe(1);
    expect(firstReplay.seq).toBe(1);

    // Simulate a lost ack: pull again from the same point.
    socket.send({ type: "pull", requestId: "pull-2", sinceSeq: 0 });
    const secondReplay = await socket.nextFor("pull-2");
    expect(secondReplay.type).toBe("ops");
    expect((secondReplay.changes as unknown[]).length).toBe(1);

    socket.send({ type: "ack", seq: 1 });
    socket.send({ type: "pull", requestId: "pull-3", sinceSeq: 1 });
    const afterAck = await socket.nextFor("pull-3");
    expect(afterAck.type).toBe("ops");
    expect((afterAck.changes as unknown[]).length).toBe(0);
  }, 15_000);

  it("resumes from the acknowledged sequence after a reconnect", async () => {
    const first = await connect();
    first.send({
      type: "push",
      requestId: "push-r1",
      baseSeq: 0,
      snapshotHash: "reconnect-hash",
      snapshot: snapshotWithBookmark(),
    });
    const pushed = await first.nextFor("push-r1");
    expect(pushed.type).toBe("push-result");
    first.send({ type: "ack", seq: 1 });
    first.close();

    const second = await connect(1);
    second.send({ type: "pull", requestId: "pull-r2", sinceSeq: 1 });
    const resumed = await second.nextFor("pull-r2");
    expect(resumed.type).toBe("ops");
    expect((resumed.changes as unknown[]).length).toBe(0);
    client = second;
  }, 15_000);
});
