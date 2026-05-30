#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createManifest, serializeManifest } from "./manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../..");
const allowlistPath = resolve(root, "docs/allowlist.txt");
const outPath = resolve(root, "packages/vgpu/lib/generated/docs-manifest.generated.js");

const manifest = createManifest(readFileSync(allowlistPath, "utf8"), {
  exists: (path) => existsSync(resolve(root, path)),
  read: (path) => readFileSync(resolve(root, path), "utf8"),
});

writeFileSync(outPath, `export const docsManifest = ${serializeManifest(manifest)};`);
