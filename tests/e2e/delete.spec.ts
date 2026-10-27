import { expect, test } from "@playwright/test";
import {
  addBookmark,
  addFolderWithBookmark,
  cleanupEndpoint,
  confirmPairing,
  countBookmark,
  delay,
  launchEndpoint,
  removeBookmarkByUrl,
  removeFolderByTitle,
  startRelayProcess,
  stopRelay,
  waitForBookmark,
  waitForBookmarkGone,
  waitForFolder,
  waitForFolderGone,
  type Endpoint,
} from "./helpers";

async function pairedEndpoints() {
  const relay = await startRelayProcess();
  const endpoints: Endpoint[] = [];
  const chromeEndpoint = await launchEndpoint("chrome", relay, "chrome");
  endpoints.push(chromeEndpoint);
  const egoEndpoint = await launchEndpoint("ego", relay, "ego");
  endpoints.push(egoEndpoint);
  await confirmPairing(chromeEndpoint);
  await confirmPairing(egoEndpoint);
  return { relay, endpoints, chromeEndpoint, egoEndpoint };
}

test("bookmark deletion propagates and never resurrects", async () => {
  const { relay, endpoints, chromeEndpoint, egoEndpoint } = await pairedEndpoints();

  try {
    const url = "https://e2e-delete.example/";
    await addBookmark(chromeEndpoint.worker, "DeleteMe", url);
    await waitForBookmark(egoEndpoint.worker, url);

    await removeBookmarkByUrl(chromeEndpoint.worker, url);
    await waitForBookmarkGone(egoEndpoint.worker, url);

    // Stay idle for a few seconds: a stale re-push must not bring it back.
    await delay(4_000);
    expect(await countBookmark(egoEndpoint.worker, url)).toBe(0);
    expect(await countBookmark(chromeEndpoint.worker, url)).toBe(0);
  } finally {
    for (const endpoint of endpoints) {
      await cleanupEndpoint(endpoint);
    }
    await stopRelay(relay);
  }
});

test("deleting a folder cascades to its bookmarks on the other endpoint", async () => {
  const { relay, endpoints, chromeEndpoint, egoEndpoint } = await pairedEndpoints();

  try {
    const folderTitle = "E2E Folder";
    const childUrl = "https://e2e-folder-child.example/";

    await addFolderWithBookmark(chromeEndpoint.worker, folderTitle, "Child", childUrl);
    await waitForFolder(egoEndpoint.worker, folderTitle);
    await waitForBookmark(egoEndpoint.worker, childUrl);

    await removeFolderByTitle(chromeEndpoint.worker, folderTitle);
    await waitForFolderGone(egoEndpoint.worker, folderTitle);
    await waitForBookmarkGone(egoEndpoint.worker, childUrl);

    await delay(3_000);
    expect(await countBookmark(egoEndpoint.worker, childUrl)).toBe(0);
  } finally {
    for (const endpoint of endpoints) {
      await cleanupEndpoint(endpoint);
    }
    await stopRelay(relay);
  }
});
