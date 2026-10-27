import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  chromium,
  expect,
  type BrowserContext,
  type Worker,
} from "@playwright/test";

export const EXTENSION_PATH = resolve(process.cwd(), "extension", "dist");

export interface RelayProcess {
  child: ChildProcess;
  port: number;
  token: string;
  workDir: string;
}

export interface Endpoint {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  userDataDir: string;
}

export async function delay(ms: number): Promise<void> {
  await new Promise((done) => setTimeout(done, ms));
}

async function spawnRelay(workDir: string, port: number): Promise<RelayProcess> {
  const entry = resolve(process.cwd(), "relay", "dist", "index.js");
  const child = spawn(process.execPath, [entry], {
    cwd: workDir,
    env: { ...process.env, RELAY_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const actualPort = await new Promise<number>((resolvePort, rejectPort) => {
    const timer = setTimeout(
      () => rejectPort(new Error(`relay start timed out\n${output}`)),
      15_000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on ws:\/\/127\.0\.0\.1:(\d+)\/ws/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPort(new Error(`relay exited with ${String(code)}\n${output}`));
    });
  });

  const token = (
    await readFile(join(workDir, "relay", "data", "token.txt"), "utf8")
  ).trim();

  return { child, port: actualPort, token, workDir };
}

export async function startRelayProcess(): Promise<RelayProcess> {
  const workDir = await mkdtemp(join(tmpdir(), "bookmark-sync-e2e-relay-"));
  return spawnRelay(workDir, 0);
}

export async function stopRelayProcess(relay: RelayProcess): Promise<void> {
  relay.child.kill();
  await delay(400);
}

export async function restartRelay(relay: RelayProcess): Promise<RelayProcess> {
  await stopRelayProcess(relay);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await spawnRelay(relay.workDir, relay.port);
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("relay restart failed");
}

export async function configureEndpoint(
  endpoint: Endpoint,
  relay: RelayProcess,
  browser: "chrome" | "ego",
  name: string,
): Promise<void> {
  // Configure through the real options page so the reconnect path is exercised.
  const page = await endpoint.context.newPage();
  await page.goto(`chrome-extension://${endpoint.extensionId}/ui/options.html`);
  await page.waitForSelector("#relay-url");
  await page.fill("#relay-url", `ws://127.0.0.1:${relay.port}/ws`);
  await page.fill("#token", relay.token);
  await page.selectOption("#browser", browser);
  await page.fill("#profile-label", name);
  await page.click('button[type="submit"]');
  await expect(page.locator("#result")).toContainText("已保存");
  await page.close();
}

export async function launchEndpoint(
  name: string,
  relay: RelayProcess,
  browser: "chrome" | "ego",
  configure = true,
): Promise<Endpoint> {
  const userDataDir = await mkdtemp(join(tmpdir(), `bookmark-sync-e2e-${name}-`));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 900, height: 700 },
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const endpoint: Endpoint = { context, worker, extensionId, userDataDir };

  if (configure) {
    await configureEndpoint(endpoint, relay, browser, name);
  }

  return endpoint;
}

async function waitForPreview(worker: Worker): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const preview = await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get("sync.preview");
      return stored["sync.preview"] ?? null;
    });
    if (preview) return;
    await delay(100);
  }
  throw new Error("pairing preview was not created");
}

export async function confirmPairing(endpoint: Endpoint): Promise<void> {
  await waitForPreview(endpoint.worker);
  const page = await endpoint.context.newPage();
  await page.goto(`chrome-extension://${endpoint.extensionId}/ui/popup.html`);
  await expect(page.locator("#preview-section")).toBeVisible();
  await page.getByRole("button", { name: "确认合并" }).click();
  await expect(page.locator("#preview-section")).toBeHidden({ timeout: 30_000 });
  await page.close();
}

export async function addBookmark(
  worker: Worker,
  title: string,
  url: string,
): Promise<void> {
  await worker.evaluate(
    async ({ title: bookmarkTitle, url: bookmarkUrl }) => {
      const tree = await chrome.bookmarks.getTree();
      const bar = tree[0]?.children?.[0];
      if (!bar) throw new Error("bookmark bar was not found");
      await chrome.bookmarks.create({
        parentId: bar.id,
        title: bookmarkTitle,
        url: bookmarkUrl,
      });
    },
    { title, url },
  );
}

export async function countBookmark(worker: Worker, url: string): Promise<number> {
  return worker.evaluate(
    async (target) => (await chrome.bookmarks.search({ url: target })).length,
    url,
  );
}

export async function waitForBookmark(worker: Worker, url: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await countBookmark(worker, url)) > 0) return;
    await delay(200);
  }
  throw new Error(`bookmark ${url} was not synchronized`);
}

export async function waitForConsistency(
  left: Worker,
  right: Worker,
  url: string,
): Promise<number> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const leftCount = await countBookmark(left, url);
    const rightCount = await countBookmark(right, url);
    if (leftCount === rightCount) return leftCount;
    await delay(200);
  }
  throw new Error(`endpoints did not converge for ${url}`);
}

export async function waitForBookmarkGone(worker: Worker, url: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await countBookmark(worker, url)) === 0) return;
    await delay(200);
  }
  throw new Error(`bookmark ${url} was not deleted`);
}

export async function removeBookmarkByUrl(worker: Worker, url: string): Promise<void> {
  await worker.evaluate(async (target) => {
    const found = await chrome.bookmarks.search({ url: target });
    for (const node of found) {
      await chrome.bookmarks.remove(node.id);
    }
  }, url);
}

export async function addFolderWithBookmark(
  worker: Worker,
  folderTitle: string,
  bookmarkTitle: string,
  url: string,
): Promise<void> {
  await worker.evaluate(
    async ({ folderTitle: name, bookmarkTitle: title, url: target }) => {
      const tree = await chrome.bookmarks.getTree();
      const bar = tree[0]?.children?.[0];
      if (!bar) throw new Error("bookmark bar was not found");
      const folder = await chrome.bookmarks.create({ parentId: bar.id, title: name });
      await chrome.bookmarks.create({ parentId: folder.id, title, url: target });
    },
    { folderTitle, bookmarkTitle, url },
  );
}

export async function countFolderByTitle(worker: Worker, title: string): Promise<number> {
  return worker.evaluate(async (folderTitle) => {
    const found = await chrome.bookmarks.search({ title: folderTitle });
    return found.filter((node) => typeof node.url !== "string").length;
  }, title);
}

export async function waitForFolder(worker: Worker, title: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await countFolderByTitle(worker, title)) > 0) return;
    await delay(200);
  }
  throw new Error(`folder ${title} was not synchronized`);
}

export async function waitForFolderGone(worker: Worker, title: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await countFolderByTitle(worker, title)) === 0) return;
    await delay(200);
  }
  throw new Error(`folder ${title} was not deleted`);
}

export async function removeFolderByTitle(worker: Worker, title: string): Promise<void> {
  await worker.evaluate(async (folderTitle) => {
    const found = await chrome.bookmarks.search({ title: folderTitle });
    for (const node of found) {
      if (typeof node.url !== "string") {
        await chrome.bookmarks.removeTree(node.id);
      }
    }
  }, title);
}

export async function addNestedFoldersWithBookmark(
  worker: Worker,
  folderTitles: string[],
  bookmarkTitle: string,
  url: string,
): Promise<void> {
  await worker.evaluate(
    async ({ folderTitles: names, bookmarkTitle: title, url: target }) => {
      const tree = await chrome.bookmarks.getTree();
      let parentId = tree[0]?.children?.[0]?.id;
      if (!parentId) throw new Error("bookmark bar was not found");
      for (const name of names) {
        const folder = await chrome.bookmarks.create({ parentId, title: name });
        parentId = folder.id;
      }
      await chrome.bookmarks.create({ parentId, title, url: target });
    },
    { folderTitles, bookmarkTitle, url },
  );
}

export async function addEmptyFolders(
  worker: Worker,
  folderTitles: string[],
): Promise<void> {
  await worker.evaluate(async (names) => {
    const tree = await chrome.bookmarks.getTree();
    const bar = tree[0]?.children?.[0];
    if (!bar) throw new Error("bookmark bar was not found");
    for (const name of names) {
      await chrome.bookmarks.create({ parentId: bar.id, title: name });
    }
  }, folderTitles);
}

export async function renameFolderByTitle(
  worker: Worker,
  oldTitle: string,
  newTitle: string,
): Promise<void> {
  await worker.evaluate(
    async ({ oldTitle: from, newTitle: to }) => {
      const found = await chrome.bookmarks.search({ title: from });
      const folder = found.find(
        (node) => typeof node.url !== "string" && node.title === from,
      );
      if (!folder) throw new Error(`folder ${from} was not found`);
      await chrome.bookmarks.update(folder.id, { title: to });
    },
    { oldTitle, newTitle },
  );
}

export async function moveBookmarkToBar(worker: Worker, url: string): Promise<void> {
  await worker.evaluate(async (target) => {
    const tree = await chrome.bookmarks.getTree();
    const bar = tree[0]?.children?.[0];
    const found = await chrome.bookmarks.search({ url: target });
    if (!bar || found.length === 0) throw new Error("bookmark or bar was not found");
    await chrome.bookmarks.move(found[0]!.id, { parentId: bar.id });
  }, url);
}

export async function moveFolderUnderFolder(
  worker: Worker,
  folderTitle: string,
  targetTitle: string,
): Promise<void> {
  await worker.evaluate(
    async ({ folderTitle: from, targetTitle: to }) => {
      const sourceCandidates = await chrome.bookmarks.search({ title: from });
      const targetCandidates = await chrome.bookmarks.search({ title: to });
      const source = sourceCandidates.find(
        (node) => typeof node.url !== "string" && node.title === from,
      );
      const target = targetCandidates.find(
        (node) => typeof node.url !== "string" && node.title === to,
      );
      if (!source || !target) throw new Error("source or target folder was not found");
      await chrome.bookmarks.move(source.id, { parentId: target.id });
    },
    { folderTitle, targetTitle },
  );
}

export async function getBookmarkParentTitle(
  worker: Worker,
  url: string,
): Promise<string | null> {
  return worker.evaluate(async (target) => {
    const found = await chrome.bookmarks.search({ url: target });
    const bookmark = found[0];
    if (!bookmark?.parentId) return null;
    const parents = await chrome.bookmarks.get(bookmark.parentId);
    return parents[0]?.title ?? null;
  }, url);
}

export async function getFolderParentTitle(
  worker: Worker,
  folderTitle: string,
): Promise<string | null> {
  return worker.evaluate(async (target) => {
    const found = await chrome.bookmarks.search({ title: target });
    const folder = found.find(
      (node) => typeof node.url !== "string" && node.title === target,
    );
    if (!folder?.parentId) return null;
    const parents = await chrome.bookmarks.get(folder.parentId);
    return parents[0]?.title ?? null;
  }, folderTitle);
}

export async function getBarTitle(worker: Worker): Promise<string | null> {
  return worker.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree();
    return tree[0]?.children?.[0]?.title ?? null;
  });
}

export async function waitForBookmarkParentTitle(
  worker: Worker,
  url: string,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await getBookmarkParentTitle(worker, url)) === expected) return;
    await delay(200);
  }
  throw new Error(`bookmark ${url} did not move under ${expected}`);
}

export async function waitForFolderParentTitle(
  worker: Worker,
  folderTitle: string,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await getFolderParentTitle(worker, folderTitle)) === expected) return;
    await delay(200);
  }
  throw new Error(`folder ${folderTitle} did not move under ${expected}`);
}

export async function pairedEndpoints(): Promise<{
  relay: RelayProcess;
  endpoints: Endpoint[];
  chromeEndpoint: Endpoint;
  egoEndpoint: Endpoint;
}> {
  const relay = await startRelayProcess();
  const endpoints: Endpoint[] = [];
  try {
    const chromeEndpoint = await launchEndpoint("chrome", relay, "chrome");
    endpoints.push(chromeEndpoint);
    const egoEndpoint = await launchEndpoint("ego", relay, "ego");
    endpoints.push(egoEndpoint);
    await confirmPairing(chromeEndpoint);
    await confirmPairing(egoEndpoint);
    return { relay, endpoints, chromeEndpoint, egoEndpoint };
  } catch (error) {
    for (const endpoint of endpoints) {
      await cleanupEndpoint(endpoint).catch(() => undefined);
    }
    await stopRelay(relay).catch(() => undefined);
    throw error;
  }
}

export async function cleanupEndpoint(endpoint: Endpoint): Promise<void> {
  await endpoint.context.close();
  await rm(endpoint.userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

export async function stopRelay(relay: RelayProcess): Promise<void> {
  await stopRelayProcess(relay);
  await rm(relay.workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export async function renameBookmarkByUrl(
  worker: Worker,
  url: string,
  title: string,
): Promise<void> {
  await worker.evaluate(
    async ({ url: target, title: nextTitle }) => {
      const found = await chrome.bookmarks.search({ url: target });
      if (found[0]) {
        await chrome.bookmarks.update(found[0].id, { title: nextTitle });
      }
    },
    { url, title },
  );
}

export async function readConflicts(worker: Worker): Promise<Array<{ kind: string; detail: string }>> {
  return worker.evaluate(async () => {
    const stored = await chrome.storage.local.get("sync.conflicts");
    const conflicts = stored["sync.conflicts"];
    return Array.isArray(conflicts) ? conflicts : [];
  });
}

export async function waitForConflict(
  worker: Worker,
  kind: string,
): Promise<Array<{ kind: string; detail: string }>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const conflicts = await readConflicts(worker);
    if (conflicts.some((conflict) => conflict.kind === kind)) return conflicts;
    await delay(200);
  }
  throw new Error(`conflict ${kind} was not recorded`);
}
