import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const port = process.env.RELAY_PORT ?? "8787";
const entry = resolve(process.cwd(), "relay", "dist", "index.js");

const child = spawn(process.execPath, [entry], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, RELAY_PORT: port },
});
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});

let socket = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForHealth() {
  const url = `http://127.0.0.1:${port}/health`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(300);
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // retry
    }
  }
  throw new Error("relay did not become healthy");
}

try {
  const health = await waitForHealth();
  assert(health.status === "ok", `unexpected health status: ${String(health.status)}`);

  const token = (await readFile(resolve(process.cwd(), "relay", "data", "token.txt"), "utf8")).trim();
  assert(token.length > 0, "token file is empty");

  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  });

  const inbox = [];
  const waiters = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });

  function nextMessage(timeoutMs = 5000) {
    if (inbox.length > 0) return Promise.resolve(inbox.shift());
    return new Promise((resolveNext, rejectNext) => {
      const timer = setTimeout(() => rejectNext(new Error("timed out waiting for message")), timeoutMs);
      waiters.push((message) => {
        clearTimeout(timer);
        resolveNext(message);
      });
    });
  }

  function send(message) {
    socket.send(JSON.stringify({ v: 1, ts: Date.now(), ...message }));
  }

  const installId = "ws-smoke";
  const profileLabel = "test";
  const browser = "chrome";

  send({
    type: "hello",
    requestId: "hello-1",
    endpointId: `${installId}:${browser}:${profileLabel}`,
    installId,
    browser,
    profileLabel,
    clientVersion: "0.0.0-smoke",
    token,
    lastSeq: 0,
  });

  const welcome = await nextMessage();
  assert(welcome.type === "welcome", `expected welcome, got ${welcome.type}`);
  assert(typeof welcome.seq === "number", "welcome.seq missing");
  assert(welcome.resume === "incremental" || welcome.resume === "snapshot", "welcome.resume invalid");

  send({ type: "pull", requestId: "pull-1", sinceSeq: 0 });
  const ops = await nextMessage();
  assert(ops.type === "ops", `expected ops, got ${ops.type}`);
  assert(Array.isArray(ops.changes), "ops.changes is not an array");

  send({ type: "ping", ts: Date.now() });
  const pong = await nextMessage();
  assert(pong.type === "pong", `expected pong, got ${pong.type}`);

  send({ type: "ack", seq: ops.seq });

  console.log(
    `ws smoke ok: resume=${welcome.resume} seq=${welcome.seq} changes=${ops.changes.length}`,
  );
} finally {
  if (socket) {
    try {
      socket.close();
    } catch {
      // ignore
    }
  }
  child.kill();
}
