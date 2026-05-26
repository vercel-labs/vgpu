import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createManifest, serializeManifest } from "./manifest.ts";

const packageDir = process.cwd();
const repoRoot = resolve(packageDir, "../..");
const allowlistPath = resolve(repoRoot, "docs/allowlist.txt");
const outPath = resolve(packageDir, "src/generated/docs-manifest.generated.ts");

const manifest = createManifest(readFileSync(allowlistPath, "utf8"), {
  exists: (path) => existsSync(resolve(repoRoot, path)),
  read: (path) => readFileSync(resolve(repoRoot, path), "utf8"),
});

writeFileSync(outPath, serializeManifest(manifest));
