import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  safeParseClientMessage,
  type ClientMessage,
  type CommitMessage,
  type Conflict,
  type Counts,
  type ErrorCode,
  type HelloMessage,
  type PushMessage,
  type ServerMessage,
} from "@bookmark-sync/core/protocol";
import { mergePush, validatePushSnapshot, type Change } from "@bookmark-sync/core";
import { StateStore } from "./state-store";
import { SessionManager } from "./session";

const SERVER_VERSION = "0.1.0";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 90_000;
const IDLE_CHECK_INTERVAL_MS = 15_000;

export interface RelayOptions {
  port?: number;
  host?: string;
  dataDir?: string;
}

export interface RelayHandle {
  httpServer: HttpServer;
  port: number;
  host: string;
  dataDir: string;
  token: string;
  tokenFile: string;
  store: StateStore;
  sessions: SessionManager;
  close(): Promise<void>;
}

interface ConnectionContext {
  endpointId: string | null;
  lastMessageAt: number;
  helloTimer: ReturnType<typeof setTimeout> | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function verifyToken(provided: string, expectedHash: string): boolean {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = Buffer.from(expectedHash, "hex");
  if (providedDigest.length !== expectedDigest.length) return false;
  return timingSafeEqual(providedDigest, expectedDigest);
}

function rawDataSize(raw: RawData): number {
  if (Array.isArray(raw)) {
    return raw.reduce((total, chunk) => total + chunk.length, 0);
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength;
  }
  return raw.length;
}

function rawDataToString(raw: RawData): string {
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

function formatZodError(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

async function loadOrCreateToken(dataDir: string): Promise<{ token: string; tokenFile: string }> {
  const tokenFile = join(dataDir, "token.txt");
  try {
    const existing = (await readFile(tokenFile, "utf8")).trim();
    if (existing.length > 0) return { token: existing, tokenFile };
  } catch {
    // fall through and create a new token
  }
  await mkdir(dataDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  await writeFile(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return { token, tokenFile };
}

export async function startRelay(options: RelayOptions = {}): Promise<RelayHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.RELAY_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid relay port: ${String(port)}`);
  }
  const dataDir = resolve(options.dataDir ?? join(process.cwd(), "relay", "data"));

  const store = await StateStore.open({ dataDir });
  const sessions = new SessionManager(store);
  const { token, tokenFile } = await loadOrCreateToken(dataDir);
  const tokenHash = hashToken(token);
  const startedAt = Date.now();

  const contexts = new Map<WebSocket, ConnectionContext>();

  function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  function sendError(
    socket: WebSocket,
    code: ErrorCode,
    message: string,
    requestId?: string,
    retryable = false,
  ): void {
    send(socket, {
      v: PROTOCOL_VERSION,
      type: "error",
      ts: Date.now(),
      code,
      message,
      retryable,
      ...(requestId ? { requestId } : {}),
    });
  }

  async function handleHello(
    socket: WebSocket,
    context: ConnectionContext,
    message: HelloMessage,
  ): Promise<void> {
    const expectedEndpointId = `${message.installId}:${message.browser}:${message.profileLabel}`;
    if (message.endpointId !== expectedEndpointId) {
      sendError(socket, "BAD_REQUEST", "endpointId does not match installId/browser/profileLabel", message.requestId);
      socket.close(4401, "invalid endpoint identity");
      return;
    }
    if (!verifyToken(message.token, tokenHash)) {
      sendError(socket, "AUTH_FAILED", "invalid token", message.requestId);
      socket.close(4401, "invalid token");
      return;
    }

    context.endpointId = message.endpointId;
    if (context.helloTimer) {
      clearTimeout(context.helloTimer);
      context.helloTimer = null;
    }

    sessions.attach(message.endpointId, socket);
    const endpoint = await sessions.registerEndpoint({
      endpointId: message.endpointId,
      browser: message.browser,
      profileLabel: message.profileLabel,
      tokenHash,
      lastSeq: message.lastSeq,
    });

    const state = store.getState();
    const firstRetained = sessions.firstRetainedSeq(state);
    const resume = message.lastSeq < firstRetained - 1 ? "snapshot" : "incremental";

    send(socket, {
      v: PROTOCOL_VERSION,
      type: "welcome",
      requestId: message.requestId,
      ts: Date.now(),
      serverVersion: SERVER_VERSION,
      seq: state.seq,
      lastSeq: endpoint.lastSeq,
      resume,
      endpointStatus: endpoint.status,
    });
  }

  interface CachedPreview {
    endpointId: string;
    snapshotHash: string;
    push: PushMessage["snapshot"];
    expiresAt: number;
  }

  interface ApplyOutcome {
    applied: boolean;
    counts: Counts;
    bindings: Array<{ localId: string; syncId: string }>;
    conflicts: Conflict[];
    changes: Change[];
    seq: number;
  }

  const previews = new Map<string, CachedPreview>();

  function zeroCounts(): Counts {
    return { added: 0, updated: 0, moved: 0, deleted: 0, resurrected: 0, conflicts: 0 };
  }

  async function applyPushSnapshot(
    socket: WebSocket,
    endpointId: string,
    pushSnapshot: PushMessage["snapshot"],
    snapshotHash: string,
    requestId: string,
    dryRun: boolean,
  ): Promise<void> {
    if (dryRun) {
      const clone = structuredClone(store.getState());
      const previewOutcome = mergePush({
        state: clone,
        endpointId,
        push: pushSnapshot,
        previous: clone.snapshots[endpointId],
        newSyncId: () => randomUUID(),
        now: Date.now(),
      });

      const now = Date.now();
      for (const [key, preview] of previews) {
        if (preview.expiresAt < now) previews.delete(key);
      }
      previews.set(requestId, {
        endpointId,
        snapshotHash,
        push: pushSnapshot,
        expiresAt: now + 5 * 60_000,
      });

      send(socket, {
        v: PROTOCOL_VERSION,
        type: "push-result",
        requestId,
        ts: now,
        seq: store.getState().seq,
        applied: false,
        dryRun: true,
        counts: previewOutcome.counts,
        bindings: previewOutcome.bindings,
        conflicts: previewOutcome.conflicts,
      });
      return;
    }

    const isFirstSnapshot = !store.getState().snapshots[endpointId];
    if (isFirstSnapshot) {
      await store.backupNow();
    }

    const outcome = await store.mutate((state): ApplyOutcome => {
      const endpoint = state.endpoints[endpointId];

      if (endpoint && endpoint.lastSnapshotHash === snapshotHash) {
        return {
          applied: false,
          counts: zeroCounts(),
          bindings: [],
          conflicts: [],
          changes: [],
          seq: state.seq,
        };
      }

      const merged = mergePush({
        state,
        endpointId,
        push: pushSnapshot,
        previous: state.snapshots[endpointId],
        newSyncId: () => randomUUID(),
        now: Date.now(),
      });
      const changes = sessions.appendChangesToState(state, endpointId, merged.changes);
      const capturedAt = Date.now();

      const deleteSeqBySyncId = new Map<string, number>();
      for (const change of changes) {
        if (change.type === "delete") deleteSeqBySyncId.set(change.syncId, change.seq);
      }
      for (const tombstone of merged.tombstones) {
        state.tombstones[tombstone.syncId] = {
          ...tombstone,
          seq: deleteSeqBySyncId.get(tombstone.syncId) ?? state.seq,
        };
      }

      state.snapshots[endpointId] = {
        endpointId,
        seqAtCapture: state.seq,
        capturedAt,
        hash: snapshotHash,
        nodes: merged.snapshotNodes,
      };

      if (endpoint) {
        endpoint.lastSnapshotHash = snapshotHash;
        endpoint.lastSeenAt = capturedAt;
        endpoint.status = "online";
      }

      return {
        applied: changes.length > 0,
        counts: merged.counts,
        bindings: merged.bindings,
        conflicts: merged.conflicts,
        changes,
        seq: state.seq,
      };
    });

    if (outcome.changes.length > 0) {
      sessions.broadcast(endpointId, {
        v: PROTOCOL_VERSION,
        type: "ops",
        requestId: randomUUID(),
        ts: Date.now(),
        seq: outcome.seq,
        hasMore: false,
        changes: outcome.changes,
      });
    }

    send(socket, {
      v: PROTOCOL_VERSION,
      type: "push-result",
      requestId,
      ts: Date.now(),
      seq: outcome.seq,
      applied: outcome.applied,
      dryRun: false,
      counts: outcome.counts,
      bindings: outcome.bindings,
      conflicts: outcome.conflicts,
    });
  }

  async function handleCommit(
    socket: WebSocket,
    endpointId: string,
    message: CommitMessage,
  ): Promise<void> {
    const preview = previews.get(message.previewRequestId);
    if (!preview || preview.endpointId !== endpointId || preview.expiresAt < Date.now()) {
      sendError(socket, "PREVIEW_EXPIRED", "preview not found or expired", message.requestId, true);
      return;
    }
    if (preview.snapshotHash !== message.snapshotHash) {
      sendError(socket, "HASH_MISMATCH", "snapshot hash does not match the preview", message.requestId, true);
      return;
    }
    previews.delete(message.previewRequestId);
    await applyPushSnapshot(
      socket,
      endpointId,
      preview.push,
      preview.snapshotHash,
      message.requestId,
      false,
    );
  }

  async function handleAuthed(
    socket: WebSocket,
    context: ConnectionContext,
    message: Exclude<ClientMessage, { type: "hello" }>,
  ): Promise<void> {
    const endpointId = context.endpointId;
    if (!endpointId) {
      sendError(socket, "AUTH_FAILED", "hello required", "requestId" in message ? message.requestId : undefined);
      socket.close(4401, "hello required");
      return;
    }

    switch (message.type) {
      case "ping": {
        send(socket, { v: PROTOCOL_VERSION, type: "pong", ts: Date.now() });
        return;
      }
      case "ack": {
        await sessions.acknowledge(endpointId, message.seq);
        return;
      }
      case "pull": {
        const state = store.getState();
        const firstRetained = sessions.firstRetainedSeq(state);
        if (message.sinceSeq < firstRetained - 1) {
          sendError(
            socket,
            "SEQ_GAP",
            `sinceSeq ${message.sinceSeq} is behind retained changes (first retained: ${firstRetained})`,
            message.requestId,
            true,
          );
          return;
        }
        const page = sessions.getChangesSince(message.sinceSeq, message.limit ?? 500);
        send(socket, {
          v: PROTOCOL_VERSION,
          type: "ops",
          requestId: message.requestId,
          ts: Date.now(),
          seq: page.seq,
          hasMore: page.hasMore,
          changes: page.changes,
        });
        return;
      }
      case "resync": {
        const state = store.getState();
        send(socket, {
          v: PROTOCOL_VERSION,
          type: "snapshot",
          requestId: message.requestId,
          ts: Date.now(),
          seq: state.seq,
          nodes: Object.values(state.nodes).map((node) => ({
            syncId: node.syncId,
            kind: node.kind,
            title: node.title,
            url: node.url,
            parentSyncId: node.parentSyncId,
            rootKey: node.rootKey,
            position: node.position,
            createdAt: node.createdAt,
            modifiedAt: node.modifiedAt,
            deleted: node.deleted,
          })),
          tombstones: Object.values(state.tombstones).map((tombstone) => ({
            syncId: tombstone.syncId,
            deletedAt: tombstone.deletedAt,
            seq: tombstone.seq,
          })),
        });
        return;
      }
      case "push": {
        const validationError = validatePushSnapshot(message.snapshot.nodes);
        if (validationError) {
          sendError(socket, "BAD_REQUEST", validationError, message.requestId);
          return;
        }

        const state = store.getState();
        const firstRetained = sessions.firstRetainedSeq(state);
        if (message.baseSeq < firstRetained - 1) {
          sendError(
            socket,
            "SEQ_GAP",
            `baseSeq ${message.baseSeq} is behind retained changes (first retained: ${firstRetained})`,
            message.requestId,
            true,
          );
          return;
        }
        if (message.baseSeq > state.seq) {
          sendError(
            socket,
            "BAD_REQUEST",
            `baseSeq ${message.baseSeq} is ahead of relay state (${state.seq})`,
            message.requestId,
          );
          return;
        }
        await applyPushSnapshot(
          socket,
          endpointId,
          message.snapshot,
          message.snapshotHash,
          message.requestId,
          message.dryRun === true,
        );
        return;
      }
      case "commit": {
        await handleCommit(socket, endpointId, message);
        return;
      }
      default: {
        sendError(socket, "BAD_REQUEST", "unsupported message", undefined);
      }
    }
  }

  async function handleMessage(
    socket: WebSocket,
    context: ConnectionContext,
    raw: RawData,
  ): Promise<void> {
    context.lastMessageAt = Date.now();
    if (rawDataSize(raw) > MAX_FRAME_BYTES) {
      sendError(socket, "PAYLOAD_TOO_LARGE", "frame exceeds 8 MiB");
      socket.close(1009, "payload too large");
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(rawDataToString(raw));
    } catch {
      sendError(socket, "BAD_REQUEST", "invalid JSON");
      return;
    }

    const parsed = safeParseClientMessage(json);
    if (!parsed.success) {
      sendError(socket, "BAD_REQUEST", formatZodError(parsed.error));
      return;
    }

    const message = parsed.data;
    if (!context.endpointId) {
      if (message.type !== "hello") {
        const requestId = "requestId" in message ? message.requestId : undefined;
        sendError(socket, "AUTH_FAILED", "hello required", requestId);
        socket.close(4401, "hello required");
        return;
      }
      await handleHello(socket, context, message);
      return;
    }

    if (message.type === "hello") {
      sendError(socket, "BAD_REQUEST", "connection is already authenticated", message.requestId);
      return;
    }

    await handleAuthed(socket, context, message);
    await sessions.touch(context.endpointId);
  }

  const httpServer = createServer((request: IncomingMessage, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (request.method === "GET" && url.pathname === "/health") {
      const state = store.getState();
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          status: "ok",
          version: SERVER_VERSION,
          seq: state.seq,
          endpointsOnline: sessions.onlineCount,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });

  wss.on("connection", (socket: WebSocket) => {
    const context: ConnectionContext = {
      endpointId: null,
      lastMessageAt: Date.now(),
      helloTimer: setTimeout(() => {
        if (!context.endpointId) {
          sendError(socket, "AUTH_FAILED", "hello timeout");
          socket.close(4401, "hello timeout");
        }
      }, HELLO_TIMEOUT_MS),
    };
    contexts.set(socket, context);

    socket.on("message", (raw) => {
      void handleMessage(socket, context, raw).catch((error: unknown) => {
        console.error("[relay] message handler failed", error);
        sendError(socket, "INTERNAL", "internal error", undefined, true);
      });
    });

    socket.on("close", () => {
      if (context.helloTimer) clearTimeout(context.helloTimer);
      contexts.delete(socket);
      const endpointId = context.endpointId;
      if (endpointId && sessions.detach(endpointId, socket)) {
        void sessions.setStatus(endpointId, "offline").catch((error: unknown) => {
          console.error("[relay] failed to mark endpoint offline", error);
        });
      }
    });

    socket.on("error", (error) => {
      console.warn("[relay] socket error", error.message);
    });
  });

  const idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [socket, context] of contexts) {
      if (now - context.lastMessageAt > IDLE_TIMEOUT_MS) {
        try {
          socket.close(4408, "idle timeout");
        } catch {
          socket.terminate();
        }
      }
    }
  }, IDLE_CHECK_INTERVAL_MS);
  idleTimer.unref();

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolveListen();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, host);
  });

  const address = httpServer.address();
  const listeningPort =
    typeof address === "object" && address !== null ? address.port : port;

  async function close(): Promise<void> {
    clearInterval(idleTimer);
    for (const socket of wss.clients) {
      try {
        socket.terminate();
      } catch {
        // ignore
      }
    }
    // Let close handlers enqueue their final status writes before flushing.
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    await store.flush();
    await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
  }

  return {
    httpServer,
    port: listeningPort,
    host,
    dataDir,
    token,
    tokenFile,
    store,
    sessions,
    close,
  };
}
