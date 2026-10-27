import { expect, test } from "@playwright/test";
import {
  addBookmark,
  cleanupEndpoint,
  countBookmark,
  delay,
  pairedEndpoints,
  readConflicts,
  removeBookmarkByUrl,
  renameBookmarkByUrl,
  restartRelay,
  stopRelay,
  stopRelayProcess,
  waitForBookmark,
  waitForConflict,
  waitForConsistency,
  type Endpoint,
} from "./helpers";

test("offline edits catch up after restart and pause blocks writes", async () => {
  const paired = await pairedEndpoints();
  let relay = paired.relay;
  const { endpoints, chromeEndpoint, egoEndpoint } = paired;

  try {
    await stopRelayProcess(relay);

    const alpha = "https://e2e-offline-alpha.example/";
    const beta = "https://e2e-offline-beta.example/";
    await addBookmark(chromeEndpoint.worker, "Offline Alpha", alpha);
    await addBookmark(egoEndpoint.worker, "Offline Beta", beta);
    await delay(1_500);

    expect(await countBookmark(chromeEndpoint.worker, alpha)).toBe(1);
    expect(await countBookmark(egoEndpoint.worker, beta)).toBe(1);

    relay = await restartRelay(relay);
    await waitForBookmark(egoEndpoint.worker, alpha);
    await waitForBookmark(chromeEndpoint.worker, beta);

    const popup = await chromeEndpoint.context.newPage();
    await popup.goto(`chrome-extension://${chromeEndpoint.extensionId}/ui/popup.html`);
    await popup.getByRole("button", { name: "暂停同步" }).click();
    await expect(popup.getByRole("button", { name: "恢复同步" })).toBeVisible();

    const pausedUrl = "https://e2e-paused.example/";
    await addBookmark(chromeEndpoint.worker, "Paused", pausedUrl);
    await delay(2_500);
    expect(await countBookmark(egoEndpoint.worker, pausedUrl)).toBe(0);

    await popup.getByRole("button", { name: "恢复同步" }).click();
    await popup.close();
    await waitForBookmark(egoEndpoint.worker, pausedUrl);
  } finally {
    for (const endpoint of endpoints) {
      await cleanupEndpoint(endpoint);
    }
    await stopRelay(relay);
  }
});

test("delete versus edit converges under mirror and records a visible conflict", async () => {
  const paired = await pairedEndpoints();
  let relay = paired.relay;
  const { endpoints, chromeEndpoint, egoEndpoint } = paired;

  try {
    const url = "https://e2e-conflict.example/";
    await addBookmark(chromeEndpoint.worker, "Conflict", url);
    await waitForBookmark(egoEndpoint.worker, url);

    await stopRelayProcess(relay);
    await removeBookmarkByUrl(chromeEndpoint.worker, url);
    await renameBookmarkByUrl(egoEndpoint.worker, url, "Conflict Renamed");
    await delay(1_500);

    relay = await restartRelay(relay);

    // Two-way mirror: the later change wins, and both endpoints must converge
    // on the same result instead of keeping two copies.
    let conflictEndpoint: Endpoint = chromeEndpoint;
    let conflicts = await readConflicts(chromeEndpoint.worker);
    if (!conflicts.some((conflict) => conflict.kind === "delete_vs_edit")) {
      try {
        conflicts = await waitForConflict(chromeEndpoint.worker, "delete_vs_edit");
      } catch {
        conflictEndpoint = egoEndpoint;
        conflicts = await waitForConflict(egoEndpoint.worker, "delete_vs_edit");
      }
    }
    expect(conflicts.some((conflict) => conflict.kind === "delete_vs_edit")).toBe(true);

    const finalCount = await waitForConsistency(
      chromeEndpoint.worker,
      egoEndpoint.worker,
      url,
    );
    expect([0, 1]).toContain(finalCount);

    const popup = await conflictEndpoint.context.newPage();
    await popup.goto(`chrome-extension://${conflictEndpoint.extensionId}/ui/popup.html`);
    await expect(popup.locator("#conflicts-section")).toBeVisible();
    await popup.close();
  } finally {
    for (const endpoint of endpoints) {
      await cleanupEndpoint(endpoint);
    }
    await stopRelay(relay);
  }
});
