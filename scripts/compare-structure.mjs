import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const statePath = resolve(process.cwd(), "relay", "data", "state.json");
const state = JSON.parse(await readFile(statePath, "utf8"));

const active = Object.values(state.nodes).filter((node) => !node.deleted);
const canonicalById = new Map(active.map((node) => [node.syncId, node]));

function canonicalFolderPath(syncId, cache = new Map(), seen = new Set()) {
  if (cache.has(syncId)) return cache.get(syncId);
  const node = canonicalById.get(syncId);
  if (!node) return null;
  if (node.rootKey) {
    cache.set(syncId, node.rootKey);
    return node.rootKey;
  }
  if (!node.parentSyncId || seen.has(syncId)) return null;
  seen.add(syncId);
  const parentPath = canonicalFolderPath(node.parentSyncId, cache, seen);
  if (!parentPath) return null;
  const path = `${parentPath}/${node.title}`;
  cache.set(syncId, path);
  return path;
}

function canonicalNodePath(node) {
  if (node.rootKey) return node.rootKey;
  if (!node.parentSyncId) return null;
  const parentPath = canonicalFolderPath(node.parentSyncId);
  if (!parentPath) return null;
  return node.kind === "folder"
    ? `${parentPath}/${node.title}`
    : `${parentPath}/${node.title}`;
}

const canonicalFolderPaths = new Map();
for (const node of active) {
  if (node.kind !== "folder" || node.rootKey) continue;
  const path = canonicalNodePath(node);
  if (path) canonicalFolderPaths.set(node.syncId, path);
}

function localPathsForSnapshot(snapshot) {
  const byLocalId = new Map(snapshot.nodes.map((node) => [node.localId, node]));
  const cache = new Map();

  function fullPath(node, seen = new Set()) {
    if (!node) return null;
    if (node.rootKey) return node.rootKey;
    if (!node.parentLocalId || seen.has(node.localId)) return null;
    seen.add(node.localId);
    const parent = byLocalId.get(node.parentLocalId);
    if (!parent) return null;
    const parentPath = fullPath(parent, seen);
    if (!parentPath) return null;
    return `${parentPath}/${node.title}`;
  }

  function nodePath(node) {
    return fullPath(node);
  }

  const folderPaths = new Map();
  const nodePaths = new Map();
  for (const node of snapshot.nodes) {
    const path = nodePath(node);
    if (!path) continue;
    nodePaths.set(node.localId, path);
    if (node.kind === "folder" && !node.rootKey) folderPaths.set(node.syncId ?? node.localId, path);
  }
  return { byLocalId, folderPaths, nodePaths };
}

console.log(`seq=${state.seq} canonical active folders=${canonicalFolderPaths.size} bookmarks=${active.filter((node) => node.kind === "bookmark").length}`);

const endpointFolderSets = new Map();

for (const [endpointId, snapshot] of Object.entries(state.snapshots)) {
  const local = localPathsForSnapshot(snapshot);
  const snapshotBySyncId = new Map();
  for (const node of snapshot.nodes) {
    if (node.syncId) snapshotBySyncId.set(node.syncId, node);
  }

  const missing = [];
  const pathMismatch = [];
  for (const node of active) {
    const localNode = snapshotBySyncId.get(node.syncId);
    if (!localNode) {
      missing.push(node);
      continue;
    }
    const canonicalPath = canonicalNodePath(node);
    const localPath = local.nodePaths.get(localNode.localId);
    if (canonicalPath && localPath && canonicalPath !== localPath) {
      pathMismatch.push({
        syncId: node.syncId,
        kind: node.kind,
        canonical: canonicalPath,
        local: localPath,
      });
    }
  }

  const extra = [];
  for (const node of snapshot.nodes) {
    if (!node.syncId) {
      extra.push({ localId: node.localId, title: node.title, reason: "unbound" });
    } else if (!canonicalById.has(node.syncId)) {
      extra.push({ localId: node.localId, title: node.title, syncId: node.syncId, reason: "not active in canonical" });
    }
  }

  const folderPaths = new Set(local.folderPaths.values());
  endpointFolderSets.set(endpointId, folderPaths);

  console.log(`\n[${endpointId}]`);
  console.log(`  snapshot nodes=${snapshot.nodes.length} folders=${folderPaths.size}`);
  console.log(`  missing canonical nodes=${missing.length}`);
  for (const node of missing.slice(0, 10)) {
    console.log(`    - ${node.kind} ${node.syncId} "${node.title}" at ${canonicalNodePath(node)}`);
  }
  console.log(`  path mismatches=${pathMismatch.length}`);
  for (const item of pathMismatch.slice(0, 15)) {
    console.log(`    - ${item.kind} ${item.syncId}: canonical="${item.canonical}" local="${item.local}"`);
  }
  console.log(`  extra local nodes=${extra.length}`);
  for (const item of extra.slice(0, 10)) {
    console.log(`    - ${item.reason}: local=${item.localId} title="${item.title}" syncId=${item.syncId ?? "none"}`);
  }
}

if (endpointFolderSets.size >= 2) {
  const entries = [...endpointFolderSets.entries()];
  const [aId, aSet] = entries[0];
  const [bId, bSet] = entries[1];
  const onlyA = [...aSet].filter((path) => !bSet.has(path));
  const onlyB = [...bSet].filter((path) => !aSet.has(path));
  console.log(`\n[compare ${aId} vs ${bId}]`);
  console.log(`  only in first=${onlyA.length}`);
  onlyA.slice(0, 15).forEach((path) => console.log(`    - ${path}`));
  console.log(`  only in second=${onlyB.length}`);
  onlyB.slice(0, 15).forEach((path) => console.log(`    - ${path}`));
}
