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
