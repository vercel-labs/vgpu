#!/usr/bin/env node
// Drift check: regenerates the docs manifest + skill mirror into a scratch temp dir (never touches
// the working tree) and diffs it against the committed copies — packages/vgpu/lib/generated/
// docs-manifest.generated.js and skills/vgpu. Run this in CI on every PR so a generator or *.docs.md
// change that wasn't followed by `pnpm -F vgpu generate:docs` fails the build with an actionable
// message, instead of silently shipping a stale skill via `npx skills add vercel-labs/vgpu`.
//
// The generated SKILL.md carries a stamp (vgpuVersion/gitSha/generatedAt, see skill.js). Only
// gitSha and generatedAt are volatile by design (they change on every single run, even with zero
// content changes), so only those two lines are normalized to a fixed placeholder before
// comparing. vgpuVersion is NOT normalized: it's deterministic from packages/vgpu-api/package.json
// and is the one field whose entire purpose is to catch "version bumped, skill not regenerated" —
// normalizing it away would silently defeat the stamp it's supposed to make CI-detectable.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeStamp, generateDocs } from "./generate.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../..");
const committedSkillDir = resolve(root, "skills/vgpu");
const committedManifestOut = resolve(root, "packages/vgpu/lib/generated/docs-manifest.generated.js");
const REGEN_HINT = "pnpm -F vgpu generate:docs";

const scratch = mkdtempSync(join(tmpdir(), "vgpu-skill-drift-"));
const freshSkillDir = join(scratch, "skills-vgpu");
const freshManifestOut = join(scratch, "docs-manifest.generated.js");

let mismatches;
try {
  generateDocs({ root, skillDir: freshSkillDir, manifestOut: freshManifestOut, stamp: computeStamp(root) });
  mismatches = [
    ...diffManifest(committedManifestOut, freshManifestOut),
    ...diffSkillDir(committedSkillDir, freshSkillDir),
  ];
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (mismatches.length > 0) {
  console.error(
    `::error::skills/vgpu (or the docs manifest) is out of date; run \`${REGEN_HINT}\` and commit the result.`,
  );
  for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
  process.exit(1);
}

console.log("skills/vgpu and the docs manifest match the generator output — no drift.");

function diffManifest(committedPath, freshPath) {
  const committed = safeRead(committedPath);
  const fresh = safeRead(freshPath);
  if (committed === fresh) return [];
  return [`docs manifest differs from generator output: ${relative(root, committedPath)}`];
}

function diffSkillDir(committedDir, freshDir) {
  const committedFiles = listFiles(committedDir);
  const freshFiles = listFiles(freshDir);
  const issues = [];

  for (const relPath of freshFiles) {
    if (!committedFiles.has(relPath)) issues.push(`missing from skills/vgpu: ${relPath} (generator now produces it)`);
  }
  for (const relPath of committedFiles) {
    if (!freshFiles.has(relPath)) issues.push(`stale file committed in skills/vgpu: ${relPath} (generator no longer produces it)`);
  }
  for (const relPath of committedFiles) {
    if (!freshFiles.has(relPath)) continue;
    const committedContent = normalizeStamp(relPath, safeRead(join(committedDir, relPath)));
    const freshContent = normalizeStamp(relPath, safeRead(join(freshDir, relPath)));
    if (committedContent !== freshContent) issues.push(`content differs: skills/vgpu/${relPath}`);
  }
  return issues;
}

// Strip the volatile SKILL.md stamp lines before comparing — see the file-level comment.
function normalizeStamp(relPath, content) {
  if (relPath !== "SKILL.md" || content === null) return content;
  return content.replace(/^(gitSha|generatedAt): .*$/gmu, "$1: <stamp>");
}

function listFiles(dir) {
  const out = new Set();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.add(relative(dir, full));
    }
  };
  if (existsDir(dir)) walk(dir);
  return out;
}

function existsDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
