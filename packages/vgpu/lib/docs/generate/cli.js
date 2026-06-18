#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createManifest, serializeManifest } from "./manifest.js";
import { buildSkill } from "./skill.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../..");
const allowlistPath = resolve(root, "docs/allowlist.txt");
const topicsDir = resolve(root, "docs/topics");
const manifestOut = resolve(root, "packages/vgpu/lib/generated/docs-manifest.generated.js");
// Root-level skills/ dir (skills-repo convention): <repo>/skills/vgpu.
const skillDir = resolve(root, "skills/vgpu");

// Guide docs (conceptual topics) are auto-discovered from docs/topics — no allowlist entry needed.
const guides = existsSync(topicsDir)
  ? readdirSync(topicsDir)
      .filter((file) => file.endsWith(".docs.md"))
      .sort()
      .map((file) => `docs/topics/${file}`)
  : [];

const manifest = createManifest(readFileSync(allowlistPath, "utf8"), {
  exists: (path) => existsSync(resolve(root, path)),
  read: (path) => readFileSync(resolve(root, path), "utf8"),
  guides,
});

writeFileSync(manifestOut, `export const docsManifest = ${serializeManifest(manifest)};`);

// Regenerate the skill mirror (SKILL.md router + references/<doc>, one file per doc) from the same
// manifest. Wiped and rebuilt so deleted docs don't leave stale reference files behind.
rmSync(skillDir, { recursive: true, force: true });
for (const [relativePath, content] of buildSkill(manifest)) {
  const outPath = resolve(skillDir, relativePath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content);
}

const guideCount = manifest.records.filter((record) => record.kind === "guide").length;
console.log(
  `docs: ${manifest.records.length} records (${guideCount} guides) → manifest + skill at ${skillDir}`,
);
