import { expect, test } from "@playwright/test";
import {
  addBookmark,
  cleanupEndpoint,
  configureEndpoint,
  confirmPairing,
  countBookmark,
  delay,
  launchEndpoint,
  startRelayProcess,
  stopRelay,
  waitForBookmark,
  type Endpoint,
} from "./helpers";

test("pre-existing identical bookmarks are adopted, not duplicated, during pairing", async () => {
  const relay = await startRelayProcess();
  const endpoints: Endpoint[] = [];

  try {
    // Launch without settings so both browsers can hold bookmarks before pairing.
    const chromeEndpoint = await launchEndpoint("chrome", relay, "chrome", false);
    endpoints.push(chromeEndpoint);
    const egoEndpoint = await launchEndpoint("ego", relay, "ego", false);
    endpoints.push(egoEndpoint);

    const shared = "https://prepair-shared.example/";
    const egoOnly = "https://prepair-ego.example/";

    await addBookmark(chromeEndpoint.worker, "Shared", shared);
    await addBookmark(egoEndpoint.worker, "Shared", shared);
    await addBookmark(egoEndpoint.worker, "EgoOnly", egoOnly);

    await configureEndpoint(chromeEndpoint, relay, "chrome", "chrome");
    await configureEndpoint(egoEndpoint, relay, "ego", "ego");

    await confirmPairing(chromeEndpoint);
    await delay(1_000);
    await confirmPairing(egoEndpoint);

    await waitForBookmark(chromeEndpoint.worker, shared);
    await waitForBookmark(egoEndpoint.worker, shared);
    await waitForBookmark(chromeEndpoint.worker, egoOnly);
    await waitForBookmark(egoEndpoint.worker, egoOnly);

    // Give any late duplicate pushes time to surface.
    await delay(3_000);

    expect(await countBookmark(chromeEndpoint.worker, shared)).toBe(1);
    expect(await countBookmark(egoEndpoint.worker, shared)).toBe(1);
    expect(await countBookmark(chromeEndpoint.worker, egoOnly)).toBe(1);
    expect(await countBookmark(egoEndpoint.worker, egoOnly)).toBe(1);
  } finally {
    for (const endpoint of endpoints) {
      await cleanupEndpoint(endpoint);
    }
    await stopRelay(relay);
  }
});
