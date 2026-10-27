import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const extensionOut = resolve(root, "extension", "dist");
const relayOut = resolve(root, "relay", "dist");

async function buildExtension() {
  await rm(extensionOut, { recursive: true, force: true });
  await mkdir(extensionOut, { recursive: true });

  await build({
    absWorkingDir: root,
    entryPoints: {
      "background/service-worker": resolve(root, "extension", "src", "background", "service-worker.ts"),
      "ui/popup": resolve(root, "extension", "src", "ui", "popup.ts"),
      "ui/options": resolve(root, "extension", "src", "ui", "options.ts"),
    },
    outdir: extensionOut,
    bundle: true,
    format: "esm",
    target: "chrome120",
    sourcemap: true,
    logLevel: "info",
  });

  await cp(
    resolve(root, "extension", "manifest.json"),
    resolve(extensionOut, "manifest.json"),
  );
  await cp(
    resolve(root, "extension", "public"),
    resolve(extensionOut, "ui"),
    { recursive: true },
  );
}

async function buildRelay() {
  await rm(relayOut, { recursive: true, force: true });
  await mkdir(relayOut, { recursive: true });

  await build({
    absWorkingDir: root,
    entryPoints: {
      index: resolve(root, "relay", "src", "index.ts"),
    },
    outdir: relayOut,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    external: ["ws", "zod"],
    logLevel: "info",
  });
}

await buildExtension();
await buildRelay();
console.log("build complete");
