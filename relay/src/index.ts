import { startRelay } from "./server";

const relay = await startRelay();

console.log(`[relay] listening on ws://${relay.host}:${relay.port}/ws`);
console.log(`[relay] data dir: ${relay.dataDir}`);
console.log(`[relay] token file: ${relay.tokenFile}`);
console.log(`[relay] token: ${relay.token}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[relay] shutting down (${signal})`);
  try {
    await relay.close();
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
