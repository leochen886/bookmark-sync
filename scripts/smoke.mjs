import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const port = process.env.RELAY_PORT ?? "8787";
const entry = resolve(process.cwd(), "relay", "dist", "index.js");

const child = spawn(process.execPath, [entry], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: { ...process.env, RELAY_PORT: port },
});

let exited = false;
let exitCode = null;
child.on("exit", (code) => {
  exited = true;
  exitCode = code;
});

const healthUrl = `http://127.0.0.1:${port}/health`;
let healthy = false;

for (let attempt = 0; attempt < 20 && !exited; attempt += 1) {
  await delay(500);
  try {
    const response = await fetch(healthUrl);
    if (response.ok) {
      const body = await response.json();
      console.log("health:", JSON.stringify(body));
      healthy = true;
      break;
    }
  } catch {
    // retry until the timeout elapses
  }
}

if (!exited) child.kill();

if (!healthy) {
  console.error(
    exited
      ? `smoke failed: relay exited early (code ${exitCode}); the server is implemented in T011`
      : `smoke failed: no healthy response from ${healthUrl}`,
  );
  process.exit(1);
}

console.log("smoke ok");
