import type { WebSocket } from "ws";
import type {
  BrowserKind,
  CanonicalState,
  Change,
  Endpoint,
  EndpointStatus,
} from "@bookmark-sync/core";
import type { ServerMessage } from "@bookmark-sync/core/protocol";
import type { StateStore } from "./state-store";

const MAX_RETAINED_CHANGES = 5000;
const TOUCH_PERSIST_INTERVAL_MS = 10_000;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Tombstones may only be dropped once every known endpoint has acknowledged
 * past the delete and the retention window has elapsed (data-model.md §4).
 */
export function pruneTombstones(
  state: CanonicalState,
  now = Date.now(),
  retentionMs = TOMBSTONE_RETENTION_MS,
): number {
  const endpoints = Object.values(state.endpoints);
  let removed = 0;

  for (const [syncId, tombstone] of Object.entries(state.tombstones)) {
    if (now - tombstone.deletedAt < retentionMs) continue;
    if (!endpoints.every((endpoint) => endpoint.lastSeq >= tombstone.seq)) continue;

    delete state.tombstones[syncId];
    const node = state.nodes[syncId];
    if (node && node.deleted) delete state.nodes[syncId];
    removed += 1;
  }

  return removed;
}

export interface RegisterEndpointInput {
  endpointId: string;
  browser: BrowserKind;
  profileLabel: string;
  tokenHash: string;
  lastSeq: number;
}

export interface ChangesPage {
  changes: Change[];
  seq: number;
  hasMore: boolean;
}

export class SessionManager {
  private readonly connections = new Map<string, WebSocket>();
  private readonly lastPersistedTouch = new Map<string, number>();

  constructor(private readonly store: StateStore) {}

  get onlineCount(): number {
    return this.connections.size;
  }

  isOnline(endpointId: string): boolean {
    return this.connections.has(endpointId);
  }

  attach(endpointId: string, socket: WebSocket): void {
    const existing = this.connections.get(endpointId);
    if (existing && existing !== socket) {
      try {
        existing.close(4409, "replaced by a newer connection");
      } catch {
        // the old socket may already be closing
      }
    }
    this.connections.set(endpointId, socket);
  }

  /** Returns true when this socket was the active connection for the endpoint. */
  detach(endpointId: string, socket: WebSocket): boolean {
    if (this.connections.get(endpointId) !== socket) return false;
    this.connections.delete(endpointId);
    return true;
  }

  async registerEndpoint(input: RegisterEndpointInput): Promise<Endpoint> {
    return this.store.mutate((state) => {
      const now = Date.now();
      const existing = state.endpoints[input.endpointId];
      const endpoint: Endpoint = {
        endpointId: input.endpointId,
        browser: input.browser,
        profileLabel: input.profileLabel,
        tokenHash: input.tokenHash,
        lastSeq: existing ? existing.lastSeq : input.lastSeq,
        lastSeenAt: now,
        lastSnapshotHash: existing ? existing.lastSnapshotHash : null,
        status: "online",
      };
      state.endpoints[input.endpointId] = endpoint;
      return endpoint;
    });
  }

  async setStatus(endpointId: string, status: EndpointStatus): Promise<void> {
    await this.store.mutate((state) => {
      const endpoint = state.endpoints[endpointId];
      if (!endpoint) return;
      endpoint.status = status;
      endpoint.lastSeenAt = Date.now();
    });
  }

  async touch(endpointId: string): Promise<void> {
    const now = Date.now();
    const previous = this.lastPersistedTouch.get(endpointId) ?? 0;
    if (now - previous < TOUCH_PERSIST_INTERVAL_MS) return;
    this.lastPersistedTouch.set(endpointId, now);
    await this.store.mutate((state) => {
      const endpoint = state.endpoints[endpointId];
      if (endpoint) endpoint.lastSeenAt = now;
    });
  }

  async acknowledge(endpointId: string, seq: number): Promise<void> {
    await this.store.mutate((state) => {
      const endpoint = state.endpoints[endpointId];
      if (!endpoint) return;
      endpoint.lastSeq = Math.max(endpoint.lastSeq, seq);
      endpoint.lastSeenAt = Date.now();
      endpoint.status = "online";
      pruneTombstones(state, Date.now());
    });
  }

  firstRetainedSeq(state = this.store.getState()): number {
    return state.changes[0]?.seq ?? state.seq + 1;
  }

  getChangesSince(sinceSeq: number, limit = 500): ChangesPage {
    const state = this.store.getState();
    const pending = state.changes.filter((change) => change.seq > sinceSeq);
    return {
      changes: pending.slice(0, limit),
      seq: state.seq,
      hasMore: pending.length > limit,
    };
  }

  /**
   * Allocates one global sequence number per change. Must run inside a single
   * store.mutate so the merge result and the sequence numbers are persisted
   * atomically.
   */
  appendChangesToState(
    state: CanonicalState,
    origin: string,
    inputs: Omit<Change, "seq">[],
  ): Change[] {
    const appended: Change[] = [];
    for (const input of inputs) {
      state.seq += 1;
      const change: Change = { ...input, origin, seq: state.seq };
      state.changes.push(change);
      appended.push(change);
    }
    if (state.changes.length > MAX_RETAINED_CHANGES) {
      state.changes.splice(0, state.changes.length - MAX_RETAINED_CHANGES);
    }
    return appended;
  }

  async appendChanges(origin: string, inputs: Omit<Change, "seq">[]): Promise<Change[]> {
    return this.store.mutate((state) => this.appendChangesToState(state, origin, inputs));
  }

  broadcast(fromEndpointId: string, message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const [endpointId, socket] of this.connections) {
      if (endpointId === fromEndpointId) continue;
      if (socket.readyState === 1) {
        socket.send(payload);
      }
    }
  }

  sendTo(endpointId: string, message: ServerMessage): boolean {
    const socket = this.connections.get(endpointId);
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
}
