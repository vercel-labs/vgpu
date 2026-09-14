#!/usr/bin/env node
import { mkdir, readFile, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadVerifiedAsset } from "./lib/verified-asset.mjs";

if (process.argv.length !== 2) {
  throw new Error("Usage: node scripts/fetch-native-worker.mjs (no overrides)");
}
const source = new URL(
  "../tooling/native-tint-worker/c1-tint-direct-build/",
  import.meta.url
);
const lock = JSON.parse(
  await readFile(new URL("provenance/source-lock.json", source), "utf8")
);
const expected = lock.build.outputs.universal;
if (
  !Number.isSafeInteger(expected.bytes) ||
  expected.bytes < 1 ||
  expected.bytes > 16 * 1024 * 1024 ||
  !/^[a-f0-9]{64}$/.test(expected.sha256)
) {
  throw new Error("Invalid locked native worker identity");
}
const destination = fileURLToPath(
  new URL(".artifacts/bin/vgpu-tint-worker-universal", source)
);
try {
  await lstat(destination);
  throw new Error(
    "Native worker destination already exists; use a clean release checkout"
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const url = `https://github.com/vercel-labs/vgpu/releases/download/native-tint-${expected.sha256}/vgpu-tint-worker-universal`;
await mkdir(dirname(destination), { recursive: true });
await downloadVerifiedAsset({ url, expected, destination });
console.log(
  `Fetched authenticated native worker (${expected.bytes} bytes, SHA-256 ${expected.sha256}).`
);
