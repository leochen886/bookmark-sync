// Minimal service worker: records whether the bookmarks API is available
// and how many bookmark nodes this profile exposes.

function countNodes(nodes) {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    if (node.children) total += countNodes(node.children);
  }
  return total;
}

async function runCheck(reason) {
  const result = {
    reason,
    at: new Date().toISOString(),
    hasBookmarksApi: typeof chrome.bookmarks?.getTree === "function",
    hasStorageApi: typeof chrome.storage?.local?.set === "function",
    hasAlarmsApi: typeof chrome.alarms?.create === "function",
    rootIds: [],
    nodeCount: 0,
    error: null,
  };

  try {
    if (result.hasBookmarksApi) {
      const tree = await chrome.bookmarks.getTree();
      result.rootIds = tree.map((node) => node.id);
      result.nodeCount = countNodes(tree);
    }
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
  }

  await chrome.storage.local.set({ egoLoadCheck: result });
  console.log("[ego-load-check]", result);
  return result;
}

chrome.runtime.onInstalled.addListener(() => {
  runCheck("onInstalled");
});

chrome.runtime.onStartup.addListener(() => {
  runCheck("onStartup");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "run-check") {
    runCheck("popup").then(sendResponse);
    return true;
  }
  return false;
});
