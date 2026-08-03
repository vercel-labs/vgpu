#!/usr/bin/env node
// Entry point for `pnpm agent-evals`.
//
// Dependency-free on purpose (only node: builtins): its first job is to run
// correctly BEFORE anything workspace-specific is guaranteed to work on the
// current Node version.
//
// It does two things in order:
//   1. preflight the Node version — `eve` needs 24+, this repo pins 22;
//   2. pack this branch's vgpu into tarballs, then run the evals against them.
//
// Step 2 is not a convenience. The whole point of the tool is to exercise the
// vgpu in the working tree; running the evals against a stale (or absent)
// tarball set would silently measure the previous build.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = join(REPO_ROOT, "apps", "agent-evals");
const REQUIRED_MAJOR = 24;
// Exit 2, not 1, so a wrong Node is distinguishable from "the evals ran and
// something failed" (which `eve eval` reports as exit 1).
const EXIT_WRONG_NODE = 2;

const major = Number.parseInt(process.versions.node.split(".")[0], 10);

if (!Number.isInteger(major) || major < REQUIRED_MAJOR) {
  process.stderr.write(
    [
      `pnpm agent-evals: Node.js >= ${REQUIRED_MAJOR} is required, but this is v${process.versions.node}.`,
      "",
      "  apps/agent-evals is driven by `eve`, which requires Node 24+. The rest of",
      "  this repo pins Node 22 on purpose, so switch Node just for this command:",
      "",
      `      nvm install ${REQUIRED_MAJOR} && nvm use ${REQUIRED_MAJOR} && pnpm agent-evals`,
      "",
      "  You also need an AI Gateway credential (AI_GATEWAY_API_KEY or",
      "  VERCEL_OIDC_TOKEN) and a working Docker daemon.",
      "  See apps/agent-evals/README.md.",
      "",
    ].join("\n"),
  );
  process.exit(EXIT_WRONG_NODE);
}

process.stdout.write("pnpm agent-evals: packing this branch's vgpu…\n");
const pack = spawnSync(process.execPath, [join(PACKAGE_DIR, "scripts", "pack-vgpu.mjs")], {
  cwd: PACKAGE_DIR,
  stdio: "inherit",
});
if (pack.status !== 0) {
  process.stderr.write("pnpm agent-evals: packing failed; not running the evals.\n");
  process.exit(pack.status ?? 1);
}

// Hand the runtime ABSOLUTE paths.
//
// eve's dev runtime snapshots the app and runs the compiled modules from
// `<package>/.eve/dev-runtime/snapshots/<id>/source/apps/agent-evals/.eve/...`,
// so anything the bootstrap or the export hook derives from `import.meta.url`
// or from cwd lands inside that snapshot — where `.work/` does not exist,
// because it is gitignored and never copied. The first real run died exactly
// there. These variables are the contract that keeps the packer (this process),
// the runtime (snapshot) and the eval (CLI process) pointing at one directory.
const workDir = join(PACKAGE_DIR, ".work");
process.env.VGPU_EVALS_WORK_DIR ??= workDir;
process.env.VGPU_EVALS_TARBALLS_DIR ??= join(workDir, "tarballs");
process.env.VGPU_EVALS_REPO_ROOT ??= REPO_ROOT;

// Hash of the seed workspace, so the sandbox template is rebuilt when the
// starter project changes. eve copies these files into /workspace once per
// template; without this in the revalidation key, editing the fixture leaves
// the agent working in the previous one.
const seedDir = join(PACKAGE_DIR, "agent", "sandbox", "workspace");
const seedHash = createHash("sha256");
// Recursive: the seed is a directory tree, and a flat readdir throws EISDIR the
// first time someone adds a subfolder to the starter project.
const hashTree = (dir, prefix = "") => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    const label = `${prefix}${entry.name}`;
    seedHash.update(label);
    if (entry.isDirectory()) hashTree(full, `${label}/`);
    else seedHash.update(readFileSync(full));
  }
};
hashTree(seedDir);
process.env.VGPU_EVALS_WORKSPACE_KEY ??= seedHash.digest("hex").slice(0, 16);

// Also precompute the staleness key here, in the real worktree. The runtime
// cannot recompute it: `git` resolves against the snapshot's cwd, where the
// `packages/` pathspec matches nothing, so it would produce a different key and
// report the freshly built tarballs as stale.
const manifestPath = join(workDir, "tarballs", "tarballs.json");
try {
  process.env.VGPU_EVALS_SOURCE_KEY ??= JSON.parse(readFileSync(manifestPath, "utf8")).sourceKey;
} catch (error) {
  process.stderr.write(`pnpm agent-evals: could not read ${manifestPath}: ${error.message}\n`);
  process.exit(1);
}

const child = spawn("pnpm", ["--filter", "@vgpu/agent-evals", "exec", "eve", "eval", ...process.argv.slice(2)], {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

child.on("error", (error) => {
  process.stderr.write(`pnpm agent-evals: failed to start pnpm: ${error.message}\n`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    process.stderr.write(`pnpm agent-evals: terminated by signal ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
