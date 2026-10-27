import type { RootKey, SnapshotNode } from "@bookmark-sync/core";

const ROOT_BY_ID: Record<string, RootKey> = {
  "1": "bookmark_bar",
  "2": "other",
};

export interface LocalTree {
  roots: RootKey[];
  nodes: SnapshotNode[];
}

function detectRootKey(node: chrome.bookmarks.BookmarkTreeNode, index: number): RootKey | null {
  const byId = ROOT_BY_ID[node.id];
  if (byId) return byId;

  const title = (node.title ?? "").toLowerCase();
  if (title.includes("bookmarks bar") || title.includes("书签栏")) return "bookmark_bar";
  if (title.includes("other bookmarks") || title.includes("其他书签")) return "other";
  if (index === 0) return "bookmark_bar";
  if (index === 1) return "other";
  return null;
}

function collect(
  node: chrome.bookmarks.BookmarkTreeNode,
  parentLocalId: string | null,
  rootKey: RootKey,
  position: number,
  out: SnapshotNode[],
): void {
  const isFolder = typeof node.url !== "string";
  out.push({
    localId: node.id,
    parentLocalId,
    // Only the two virtual root nodes carry a rootKey. Descendants keep null,
    // otherwise the merge engine would mistake them for roots.
    rootKey: parentLocalId === null ? rootKey : null,
    kind: isFolder ? "folder" : "bookmark",
    title: node.title ?? "",
    url: isFolder ? null : (node.url ?? ""),
    position,
    dateAdded: node.dateAdded ?? 0,
  });

  if (isFolder && node.children) {
    node.children.forEach((child, index) => {
      collect(child, node.id, rootKey, index, out);
    });
  }
}

/**
 * Reads bookmark_bar and other roots. The synced (mobile) root is ignored by
 * design; v1 does not synchronize it.
 */
export async function readTree(): Promise<LocalTree> {
  const roots = await chrome.bookmarks.getTree();
  const rootNode = roots[0];
  const nodes: SnapshotNode[] = [];
  const rootKeys: RootKey[] = [];

  const children = rootNode?.children ?? [];
  children.forEach((child, index) => {
    const rootKey = detectRootKey(child, index);
    if (!rootKey) return;
    rootKeys.push(rootKey);
    collect(child, null, rootKey, 0, nodes);
  });

  return { roots: rootKeys, nodes };
}

export async function getNode(localId: string): Promise<chrome.bookmarks.BookmarkTreeNode | null> {
  try {
    const nodes = await chrome.bookmarks.get(localId);
    return nodes[0] ?? null;
  } catch {
    return null;
  }
}

export async function getSubtree(
  localId: string,
): Promise<chrome.bookmarks.BookmarkTreeNode[]> {
  try {
    return await chrome.bookmarks.getSubTree(localId);
  } catch {
    return [];
  }
}

/**
 * Finds an existing local node with the same parent, kind and content. Used
 * before creating a node for a remote add, so an unbound local bookmark is
 * adopted instead of duplicated.
 */
export async function findLocalContentMatch(input: {
  parentLocalId: string;
  kind: "bookmark" | "folder";
  title: string;
  url: string | null;
}): Promise<chrome.bookmarks.BookmarkTreeNode | null> {
  const query =
    input.kind === "bookmark" ? { url: input.url ?? "" } : { title: input.title };

  let candidates: chrome.bookmarks.BookmarkTreeNode[];
  try {
    candidates = await chrome.bookmarks.search(query);
  } catch {
    return null;
  }

  for (const candidate of candidates) {
    if (candidate.parentId !== input.parentLocalId) continue;
    const isFolder = typeof candidate.url !== "string";
    if (input.kind === "folder" ? !isFolder : isFolder) continue;
    if ((candidate.title ?? "") !== input.title) continue;
    if (input.kind === "bookmark" && candidate.url !== (input.url ?? "")) continue;
    return candidate;
  }

  return null;
}

export async function createBookmark(input: {
  parentLocalId: string;
  title: string;
  url: string;
  index?: number;
}): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const details: chrome.bookmarks.BookmarkCreateArg = {
    parentId: input.parentLocalId,
    title: input.title,
    url: input.url,
  };
  if (input.index !== undefined) details.index = input.index;
  return chrome.bookmarks.create(details);
}

export async function createFolder(input: {
  parentLocalId: string;
  title: string;
  index?: number;
}): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const details: chrome.bookmarks.BookmarkCreateArg = {
    parentId: input.parentLocalId,
    title: input.title,
  };
  if (input.index !== undefined) details.index = input.index;
  return chrome.bookmarks.create(details);
}

export async function updateNode(
  localId: string,
  changes: { title?: string; url?: string },
): Promise<void> {
  const details: chrome.bookmarks.BookmarkChangesArg = {};
  if (changes.title !== undefined) details.title = changes.title;
  if (changes.url !== undefined) details.url = changes.url;
  if (Object.keys(details).length === 0) return;
  await chrome.bookmarks.update(localId, details);
}

export async function moveNode(
  localId: string,
  parentLocalId: string,
  index?: number,
): Promise<void> {
  const destination: chrome.bookmarks.BookmarkDestinationArg = { parentId: parentLocalId };
  if (index !== undefined) destination.index = index;
  await chrome.bookmarks.move(localId, destination);
}

export async function removeNode(localId: string, recursive = true): Promise<void> {
  if (recursive) {
    await chrome.bookmarks.removeTree(localId);
  } else {
    await chrome.bookmarks.remove(localId);
  }
}

export interface BookmarkEventHandlers {
  onCreated?: (id: string, node: chrome.bookmarks.BookmarkTreeNode) => void;
  onRemoved?: (id: string, info: chrome.bookmarks.BookmarkRemoveInfo) => void;
  onChanged?: (id: string, info: chrome.bookmarks.BookmarkChangeInfo) => void;
  onMoved?: (id: string, info: chrome.bookmarks.BookmarkMoveInfo) => void;
  onChildrenReordered?: (id: string, info: chrome.bookmarks.BookmarkReorderInfo) => void;
  onImportEnded?: () => void;
}

export function subscribeBookmarkEvents(handlers: BookmarkEventHandlers): () => void {
  const created = (id: string, node: chrome.bookmarks.BookmarkTreeNode) => {
    handlers.onCreated?.(id, node);
  };
  const removed = (id: string, info: chrome.bookmarks.BookmarkRemoveInfo) => {
    handlers.onRemoved?.(id, info);
  };
  const changed = (id: string, info: chrome.bookmarks.BookmarkChangeInfo) => {
    handlers.onChanged?.(id, info);
  };
  const moved = (id: string, info: chrome.bookmarks.BookmarkMoveInfo) => {
    handlers.onMoved?.(id, info);
  };
  const reordered = (id: string, info: chrome.bookmarks.BookmarkReorderInfo) => {
    handlers.onChildrenReordered?.(id, info);
  };
  const importEnded = () => {
    handlers.onImportEnded?.();
  };

  chrome.bookmarks.onCreated.addListener(created);
  chrome.bookmarks.onRemoved.addListener(removed);
  chrome.bookmarks.onChanged.addListener(changed);
  chrome.bookmarks.onMoved.addListener(moved);
  chrome.bookmarks.onChildrenReordered.addListener(reordered);
  chrome.bookmarks.onImportEnded.addListener(importEnded);

  return () => {
    chrome.bookmarks.onCreated.removeListener(created);
    chrome.bookmarks.onRemoved.removeListener(removed);
    chrome.bookmarks.onChanged.removeListener(changed);
    chrome.bookmarks.onMoved.removeListener(moved);
    chrome.bookmarks.onChildrenReordered.removeListener(reordered);
    chrome.bookmarks.onImportEnded.removeListener(importEnded);
  };
}
