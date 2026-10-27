import type { NodeKind } from "@bookmark-sync/core";

const SUPPRESSION_WINDOW_MS = 1500;

export interface ExpectedNodeState {
  localId: string;
  kind?: NodeKind;
  parentLocalId?: string | null;
  title?: string;
  url?: string | null;
}

function matches(expected: ExpectedNodeState, observed: ExpectedNodeState): boolean {
  if (
    expected.kind !== undefined &&
    observed.kind !== undefined &&
    expected.kind !== observed.kind
  ) {
    return false;
  }
  if (
    expected.parentLocalId !== undefined &&
    observed.parentLocalId !== undefined &&
    expected.parentLocalId !== observed.parentLocalId
  ) {
    return false;
  }
  if (
    expected.title !== undefined &&
    observed.title !== undefined &&
    expected.title !== observed.title
  ) {
    return false;
  }
  if (expected.url !== undefined && observed.url !== undefined && expected.url !== observed.url) {
    return false;
  }
  return true;
}

/**
 * Suppresses bookmark events caused by our own writes.
 *
 * Two layers: (1) an expected-state map, which consumes an event only when the
 * observed fields match what we wrote; (2) a short time window over the local
 * ids we just touched, as a fallback for events that carry fewer fields.
 */
export class LoopGuard {
  private readonly expected = new Map<string, ExpectedNodeState>();
  private readonly windowIds = new Set<string>();
  private windowUntil = 0;
  private ignoreAllUntil = 0;

  /**
   * Suppresses every bookmark event for a short window while a batch of remote
   * changes is being written. Chrome may fire events slightly before the
   * expectation is recorded, so a batch-wide window avoids that race.
   */
  beginBatch(durationMs = SUPPRESSION_WINDOW_MS): void {
    this.ignoreAllUntil = Date.now() + durationMs;
  }

  expect(state: ExpectedNodeState): void {
    this.expected.set(state.localId, state);
  }

  expectMany(states: ExpectedNodeState[]): void {
    for (const state of states) this.expect(state);
  }

  beginApply(localIds: string[]): void {
    this.windowUntil = Date.now() + SUPPRESSION_WINDOW_MS;
    for (const localId of localIds) this.windowIds.add(localId);
  }

  consume(observed: ExpectedNodeState): boolean {
    if (Date.now() <= this.ignoreAllUntil) return true;
    const expected = this.expected.get(observed.localId);
    if (expected && matches(expected, observed)) {
      this.expected.delete(observed.localId);
      this.windowIds.delete(observed.localId);
      return true;
    }
    if (Date.now() <= this.windowUntil && this.windowIds.has(observed.localId)) {
      return true;
    }
    return false;
  }

  prune(): void {
    if (Date.now() > this.windowUntil) {
      this.windowIds.clear();
    }
  }

  reset(): void {
    this.expected.clear();
    this.windowIds.clear();
    this.windowUntil = 0;
    this.ignoreAllUntil = 0;
  }

  get pendingCount(): number {
    return this.expected.size;
  }
}
