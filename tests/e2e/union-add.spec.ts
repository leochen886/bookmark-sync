import { expect, test } from "@playwright/test";
import {
  addBookmark,
  cleanupEndpoint,
  confirmPairing,
  launchEndpoint,
  startRelayProcess,
  stopRelay,
  waitForBookmark,
  type Endpoint,
} from "./helpers";

test("Chrome and ego keep additions from both sides", async () => {
  const relay = await startRelayProcess();
  const endpoints: Endpoint[] = [];

  try {
    const chromeEndpoint = await launchEndpoint("chrome", relay, "chrome");
    endpoints.push(chromeEndpoint);
    const egoEndpoint = await launchEndpoint("ego", relay, "ego");
    endpoints.push(egoEndpoint);

    await confirmPairing(chromeEndpoint);
    await confirmPairing(egoEndpoint);

    const alpha = "https://e2e-alpha.example/";
    const beta = "https://e2e-beta.example/";

    await addBookmark(chromeEndpoint.worker, "Alpha", alpha);
    await waitForBookmark(egoEndpoint.worker, alpha);

    await addBookmark(egoEndpoint.worker, "Beta", beta);
    await waitForBookmark(chromeEndpoint.worker, beta);

    const chromeCount = await chromeEndpoint.worker.evaluate(async () => {
      const results = await chrome.bookmarks.search({ url: "https://e2e-alpha.example/" });
      const other = await chrome.bookmarks.search({ url: "https://e2e-beta.example/" });
      return results.length + other.length;
    });
    const egoCount = await egoEndpoint.worker.evaluate(async () => {
      const results = await chrome.bookmarks.search({ url: "https://e2e-alpha.example/" });
      const other = await chrome.bookmarks.search({ url: "https://e2e-beta.example/" });
      return results.length + other.length;
    });

    expect(chromeCount).toBe(2);
    expect(egoCount).toBe(2);
  } finally {
    for (const endpoint of endpoints) {
      await cleanupEndpoint(endpoint);
    }
    await stopRelay(relay);
  }
});
