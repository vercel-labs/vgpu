// Shared core for one docs-generation run: builds the manifest from docs/allowlist.txt +
// docs/topics, then writes the manifest + skill mirror. Used by both cli.js (writes into the
// repo's committed skills/vgpu) and check-drift.js (writes into a scratch temp dir so it can diff
// against the committed copy without touching the working tree).
import { execSync } from "node:child_process";
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

/**
 * Frontmatter stamp for the generated SKILL.md: the vgpu package version + the commit + date this
 * generation ran from, so a stale installed skill is detectable in the frontmatter by a human or
 * an agent without diffing anything. gitSha/generatedAt are intentionally volatile — they change on
 * every run by design — so check-drift.js normalizes them away before comparing; a stamp-only
 * difference between two generations is never reported as drift.
 */
export function computeStamp(root) {
  // NB: the public "vgpu" package (what `npx -y vgpu` runs) lives at packages/vgpu-api — the
  // "packages/vgpu" directory is the (private) @vgpu/cli package that hosts this generator.
  let vgpuVersion = "unknown";
  try {
    vgpuVersion = JSON.parse(readFileSync(resolve(root, "packages/vgpu-api/package.json"), "utf8")).version;
  } catch {}

  let gitSha = "unknown";
  try {
    gitSha = execSync("git rev-parse HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {}

  return { vgpuVersion, gitSha, generatedAt: new Date().toISOString() };
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
 * Runs one full generation: manifest + skill mirror (SKILL.md router + references/<doc>), written
 * to the given output paths. Returns the manifest so callers can log stats.
 */
export function generateDocs({ root, skillDir, manifestOut, stamp }) {
  const manifest = loadManifest(root);
  writeAtomic(manifestOut, `export const docsManifest = ${serializeManifest(manifest)};`);

  const expected = new Set();
  for (const [relativePath, content] of buildSkill(manifest, stamp)) {
    const outPath = resolve(skillDir, relativePath);
    expected.add(outPath);
    writeAtomic(outPath, content);
  }
  if (existsSync(skillDir)) prune(skillDir, expected);

  return { manifest };
}
