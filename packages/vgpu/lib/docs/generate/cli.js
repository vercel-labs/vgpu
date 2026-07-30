#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
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

// Writes are atomic (temp file in the same directory, then rename) because this generator runs
// as `prepack` for both packages/vgpu and packages/vgpu-api. `npm pack` and the docs tests can
// therefore run it concurrently, and a half-written file would be read by whichever sibling is
// mid-run. Temp names carry the pid so two runs never collide on one temp path.
const TEMP_SUFFIX = /\.\d+\.tmp$/u;
const writeAtomic = (outPath, content) => {
  mkdirSync(dirname(outPath), { recursive: true });
  const temp = `${outPath}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, outPath);
};

writeAtomic(manifestOut, `export const docsManifest = ${serializeManifest(manifest)};`);

// Regenerate the skill mirror (SKILL.md router + references/<doc>, one file per doc) from the same
// manifest. Written in place and then pruned, NOT wiped and rebuilt: a recursive wipe of this tree
// races the concurrent runs described above (rimraf fails with ENOTEMPTY when a sibling recreates a
// file mid-walk, and readers briefly see no docs at all). Writing every file first and only then
// deleting what the manifest no longer produces keeps the "no stale files" guarantee while making
// concurrent runs idempotent instead of destructive.
const expected = new Set();
for (const [relativePath, content] of buildSkill(manifest)) {
  const outPath = resolve(skillDir, relativePath);
  expected.add(outPath);
  writeAtomic(outPath, content);
}

// Depth-first so directories are considered after their contents.
const prune = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      prune(full);
      // Drop directories the manifest emptied. Ignore failures: a concurrent run may have
      // removed it already, or may be writing into it right now.
      try {
        rmdirSync(full);
      } catch {}
    } else if (!expected.has(full) && !TEMP_SUFFIX.test(entry.name)) {
      rmSync(full, { force: true });
    }
  }
};
if (existsSync(skillDir)) prune(skillDir);

const guideCount = manifest.records.filter((record) => record.kind === "guide").length;
console.log(
  `docs: ${manifest.records.length} records (${guideCount} guides) → manifest + skill at ${skillDir}`,
);
