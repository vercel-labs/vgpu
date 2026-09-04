// Shared core for one docs-generation run: builds the versioned CLI manifest from
// docs/allowlist.txt + docs/topics, then writes that manifest and the version-neutral skill router.
// Used by both cli.js (writes into the repo's committed skills/vgpu) and check-drift.js (writes into
// a scratch temp dir so it can diff against the committed copy without touching the working tree).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createManifest, serializeManifest } from "./manifest.js";
import { buildSkill } from "./skill.js";

// Writes are atomic (temp file in the same directory, then rename) because this generator runs
// as `prepack` for both packages/vgpu and packages/vgpu-api. `npm pack` and the docs tests can
// therefore run it concurrently, and a half-written file would be read by whichever sibling is
// mid-run. Temp names carry the pid so two runs never collide on one temp path.
const TEMP_SUFFIX = /\.\d+\.tmp$/u;

function writeAtomic(outPath, content) {
  mkdirSync(dirname(outPath), { recursive: true });
  const temp = `${outPath}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, outPath);
}

// Regenerate in place and then prune, NOT wipe-and-rebuild: a recursive wipe of this tree races
// concurrent runs (rimraf fails with ENOTEMPTY when a sibling recreates a file mid-walk, and
// readers briefly see no docs at all). Writing every file first and only then deleting what the
// manifest no longer produces keeps the "no stale files" guarantee while making concurrent runs
// idempotent instead of destructive. Depth-first so directories are considered after their
// contents.
function prune(dir, expected) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      prune(full, expected);
      try {
        rmdirSync(full);
      } catch {}
    } else if (!expected.has(full) && !TEMP_SUFFIX.test(entry.name)) {
      rmSync(full, { force: true });
    }
  }
}

export function loadManifest(root) {
  const allowlistPath = resolve(root, "docs/allowlist.txt");
  const topicsDir = resolve(root, "docs/topics");
  // Guide docs (conceptual topics) are auto-discovered from docs/topics — no allowlist entry needed.
  const guides = existsSync(topicsDir)
    ? readdirSync(topicsDir)
        .filter((file) => file.endsWith(".docs.md"))
        .sort()
        .map((file) => `docs/topics/${file}`)
    : [];

  return createManifest(readFileSync(allowlistPath, "utf8"), {
    exists: (path) => existsSync(resolve(root, path)),
    read: (path) => readFileSync(resolve(root, path), "utf8"),
    guides,
  });
}

/**
 * Runs one full generation: versioned CLI manifest + version-neutral SKILL.md router, written to
 * the given output paths. Returns the manifest so callers can log stats.
 */
export function generateDocs({ root, skillDir, manifestOut }) {
  const manifest = loadManifest(root);
  writeAtomic(manifestOut, `export const docsManifest = ${serializeManifest(manifest)};`);

  const expected = new Set();
  for (const [relativePath, content] of buildSkill()) {
    const outPath = resolve(skillDir, relativePath);
    expected.add(outPath);
    writeAtomic(outPath, content);
  }
  if (existsSync(skillDir)) prune(skillDir, expected);

  return { manifest };
}
