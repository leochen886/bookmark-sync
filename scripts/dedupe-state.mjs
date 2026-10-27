import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const statePath = resolve(process.cwd(), "relay", "data", "state.json");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = resolve(process.cwd(), "relay", "data", `state.pre-dedupe-${stamp}.json`);

async function relayIsRunning() {
  try {
    const response = await fetch("http://127.0.0.1:8787/health", {
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

if (await relayIsRunning()) {
  console.error("relay is still running; stop it before deduping state.json");
  process.exit(1);
}

const state = JSON.parse(await readFile(statePath, "utf8"));
await copyFile(statePath, backupPath);

const nodes = state.nodes;
const now = Date.now();
const origin = "system:dedupe";
const removed = { folders: 0, bookmarks: 0 };

function activeNodes() {
  return Object.values(nodes).filter((node) => !node.deleted);
}

function childrenMap() {
  const map = new Map();
  for (const node of activeNodes()) {
    if (!node.parentSyncId) continue;
    const list = map.get(node.parentSyncId) ?? [];
    list.push(node);
    map.set(node.parentSyncId, list);
  }
  return map;
}

function subtreeSignature(map, id) {
  const node = nodes[id];
  if (!node || node.deleted) return "";
  if (node.kind === "bookmark") return `B|${node.title}|${node.url}`;
  const children = (map.get(id) ?? [])
    .map((child) => subtreeSignature(map, child.syncId))
    .sort();
  return `F|${node.title}[${children.join(",")}]`;
}

function collectSubtree(map, id) {
  const out = [];
  const stack = [nodes[id]];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || node.deleted) continue;
    out.push(node);
    for (const child of map.get(node.syncId) ?? []) stack.push(child);
  }
  return out;
}

function deleteSubtree(map, rootId, reasonForRoot) {
  const subtree = collectSubtree(map, rootId);
  const counts = { folders: 0, bookmarks: 0 };
  for (const node of subtree) {
    if (node.deleted) continue;
    node.deleted = true;
    node.deletedAt = now;
    node.rev += 1;
    node.origin = origin;
    state.tombstones[node.syncId] = {
      syncId: node.syncId,
      deletedAt: now,
      origin,
      seq: 0,
      reason: node.syncId === rootId ? reasonForRoot : "parent_delete",
    };
    if (node.kind === "folder") counts.folders += 1;
    else counts.bookmarks += 1;
  }
  return counts;
}

// 1. Duplicate folders: only when the entire subtree is identical.
for (let pass = 0; pass < 10; pass += 1) {
  const map = childrenMap();
  const groups = new Map();
  for (const node of activeNodes()) {
    if (node.kind !== "folder" || node.rootKey) continue;
    const key = `${node.parentSyncId}|${node.title}`;
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }

  let changed = false;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.syncId.localeCompare(right.syncId),
    );
    const survivor = list[0];
    const survivorSignature = subtreeSignature(map, survivor.syncId);

    for (const duplicate of list.slice(1)) {
      const signature = subtreeSignature(map, duplicate.syncId);
      if (signature !== survivorSignature) {
        console.warn(
          `skip folder ${duplicate.syncId}: subtree differs from ${survivor.syncId}`,
        );
        continue;
      }
      const counts = deleteSubtree(map, duplicate.syncId, "user_delete");
      removed.folders += counts.folders;
      removed.bookmarks += counts.bookmarks;
      changed = true;
    }
  }

  if (!changed) break;
}

// 2. Duplicate bookmarks in the same parent with the same title and URL.
for (let pass = 0; pass < 10; pass += 1) {
  const groups = new Map();
  for (const node of activeNodes()) {
    if (node.kind !== "bookmark") continue;
    const key = `${node.parentSyncId}|${node.title}|${node.url}`;
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }

  let changed = false;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.syncId.localeCompare(right.syncId),
    );
    for (const duplicate of list.slice(1)) {
      const map = childrenMap();
      const counts = deleteSubtree(map, duplicate.syncId, "user_delete");
      removed.folders += counts.folders;
      removed.bookmarks += counts.bookmarks;
      changed = true;
    }
  }

  if (!changed) break;
}

// Normalize positions of the surviving siblings.
const byParent = new Map();
for (const node of Object.values(nodes)) {
  if (node.deleted || !node.parentSyncId) continue;
  const list = byParent.get(node.parentSyncId) ?? [];
  list.push(node);
  byParent.set(node.parentSyncId, list);
}
for (const siblings of byParent.values()) {
  siblings.sort(
    (left, right) =>
      left.position - right.position ||
      left.createdAt - right.createdAt ||
      left.syncId.localeCompare(right.syncId),
  );
  siblings.forEach((sibling, index) => {
    sibling.position = index;
  });
}

// Force every endpoint onto a full snapshot on its next hello.
state.changes = [];
state.seq += 1;
for (const tombstone of Object.values(state.tombstones)) {
  if (tombstone.seq === 0) tombstone.seq = state.seq;
}

const payload = `${JSON.stringify(state, null, 2)}\n`;
const tempPath = resolve(
  process.cwd(),
  "relay",
  "data",
  `state.json.tmp-dedupe-${Date.now()}`,
);
await writeFile(tempPath, payload, "utf8");

for (let attempt = 0; attempt < 8; attempt += 1) {
  try {
    await rename(tempPath, statePath);
    break;
  } catch (error) {
    if (attempt === 7) throw error;
    await delay(100 * (attempt + 1));
  }
}

const remaining = activeNodes();
console.log(
  JSON.stringify(
    {
      backup: backupPath,
      removed,
      newSeq: state.seq,
      activeBookmarks: remaining.filter((node) => node.kind === "bookmark").length,
      activeFolders: remaining.filter((node) => node.kind === "folder" && !node.rootKey)
        .length,
      tombstones: Object.keys(state.tombstones).length,
    },
    null,
    2,
  ),
);
