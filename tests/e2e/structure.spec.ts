import { expect, test } from "@playwright/test";
import {
  addEmptyFolders,
  addNestedFoldersWithBookmark,
  cleanupEndpoint,
  countBookmark,
  countFolderByTitle,
  getBarTitle,
  moveBookmarkToBar,
  moveFolderUnderFolder,
  pairedEndpoints,
  renameFolderByTitle,
  stopRelay,
  waitForBookmark,
  waitForBookmarkParentTitle,
  waitForFolder,
  waitForFolderGone,
  waitForFolderParentTitle,
} from "./helpers";

test("folder hierarchy, rename and bookmark move stay in sync", async () => {
  const { relay, endpoints, chromeEndpoint, egoEndpoint } = await pairedEndpoints();

  try {
    const url = "https://e2e-structure.example/";
    await addNestedFoldersWithBookmark(
      chromeEndpoint.worker,
      ["Work", "Project"],
      "Deep",
      url,
    );

    await waitForFolder(egoEndpoint.worker, "Work");
    await waitForFolder(egoEndpoint.worker, "Project");
    await waitForBookmark(egoEndpoint.worker, url);
    await waitForBookmarkParentTitle(egoEndpoint.worker, url, "Project");

    await renameFolderByTitle(chromeEndpoint.worker, "Project", "Archive");
    await waitForFolder(egoEndpoint.worker, "Archive");
    await waitForFolderGone(egoEndpoint.worker, "Project");
    await waitForBookmarkParentTitle(egoEndpoint.worker, url, "Archive");
    expect(await countBookmark(egoEndpoint.worker, url)).toBe(1);

    const barTitle = await getBarTitle(chromeEndpoint.worker);
    expect(barTitle).toBeTruthy();
    await moveBookmarkToBar(chromeEndpoint.worker, url);
    await waitForBookmarkParentTitle(egoEndpoint.worker, url, barTitle as string);
    expect(await countBookmark(egoEndpoint.worker, url)).toBe(1);
  } finally {
    for (const endpoint of endpoints) {
      await cleanupEndpoint(endpoint);
    }
    await stopRelay(relay);
  }
});

test("moving a folder under another folder propagates", async () => {
  const { relay, endpoints, chromeEndpoint, egoEndpoint } = await pairedEndpoints();

  try {
    await addEmptyFolders(chromeEndpoint.worker, ["Source", "Target"]);
    await waitForFolder(egoEndpoint.worker, "Source");
    await waitForFolder(egoEndpoint.worker, "Target");

    await moveFolderUnderFolder(chromeEndpoint.worker, "Source", "Target");
    await waitForFolderParentTitle(egoEndpoint.worker, "Source", "Target");
    expect(await countFolderByTitle(egoEndpoint.worker, "Source")).toBe(1);
    expect(await countFolderByTitle(egoEndpoint.worker, "Target")).toBe(1);
  } finally {
    for (const endpoint of endpoints) {
      await cleanupEndpoint(endpoint);
    }
    await stopRelay(relay);
  }
});
