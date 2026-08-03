#!/usr/bin/env node
// Pack the vgpu packages of THIS BRANCH into installable tarballs.
//
// This is the whole point of the tool: the agent must be handed the working
// tree's vgpu, not whatever is on npm. Publishing to a registry to test a
// change is a non-starter, and `file:` links into the monorepo would let the
// agent read the repo's own sources (the answer) instead of discovering the
// library from its published surface.
//
// What gets packed: `vgpu` plus the transitive closure of its `workspace:*`
// dependencies. The closure is computed, never hardcoded, so adding a package
// to vgpu's dependencies does not silently ship a broken tarball set.
//
// Two build-order facts this script depends on (both verified against the
// working tree, both easy to get wrong):
//   * `vgpu`'s own build runs `scripts/copy-cli.mjs`, which copies the CLI out
//     of the PRIVATE `@vgpu/cli` package. `@vgpu/cli` is not a dependency of
//     `vgpu`, so `--filter vgpu...` does NOT build it — it is added to the
//     build set explicitly, otherwise `npx vgpu` in the sandbox is stale or
//     missing.
//   * `vgpu`'s `prepack` runs `generate:docs` from that same package, so
//     `vgpu docs` inside the sandbox only works if packing runs the lifecycle
//     script (i.e. do not pass --ignore-scripts here).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The package the agent is asked to use; everything else follows from its deps. */
const ROOT_PACKAGE = "vgpu";
/** Private, not packed, but must be built first (see header). */
const BUILD_ONLY = ["@vgpu/cli"];

function repoRoot() {
  let dir = PACKAGE_ROOT;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("pack-vgpu: could not find the workspace root");
    dir = parent;
  }
  return dir;
}

/** name -> { dir, pkg } for every package under packages/. */
function readWorkspacePackages(root) {
  const packagesDir = join(root, "packages");
  /** @type {Map<string, { dir: string, pkg: any }>} */
  const byName = new Map();
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (pkg.name) byName.set(pkg.name, { dir, pkg });
  }
  return byName;
}

/** Transitive closure of `workspace:` dependencies, starting at ROOT_PACKAGE. */
function workspaceClosure(byName, rootName) {
  const seen = new Set();
  const order = [];
  const visit = (name) => {
    if (seen.has(name)) return;
    const entry = byName.get(name);
    if (!entry) throw new Error(`pack-vgpu: ${name} is not a workspace package`);
    seen.add(name);
    const deps = {
      ...(entry.pkg.dependencies ?? {}),
      ...(entry.pkg.optionalDependencies ?? {}),
      ...(entry.pkg.peerDependencies ?? {}),
    };
    for (const [dep, range] of Object.entries(deps)) {
      if (String(range).startsWith("workspace:")) visit(dep);
    }
    order.push(name); // dependencies first
  };
  visit(rootName);
  return order;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`pack-vgpu: \`${command} ${args.join(" ")}\` failed in ${cwd}`);
  }
  return result.stdout ?? "";
}

/**
 * Content key for the SOURCE the tarballs are built from.
 *
 * This is the sandbox template's cache key, so it has one hard requirement:
 * packing an unchanged tree twice must produce the same value. Hashing the
 * tarball bytes does not satisfy that — `vgpu`'s tarball is not byte-reproducible
 * across packs (its `prepack` regenerates docs), so a bytes-based key rebuilt the
 * template on every single run: six installs, a doctor probe and a renderer
 * download, every time.
 *
 * Hashing the inputs instead is both stable and stricter: it moves when the
 * commit moves AND when the working tree moves, so an uncommitted edit to
 * `packages/` is still a different key. Untracked file contents are included
 * explicitly, since `git diff` says nothing about them.
 */
export function sourceKey() {
  const root = repoRoot();
  const hash = createHash("sha256");
  hash.update(run("git", ["rev-parse", "HEAD"], root));
  hash.update(run("git", ["status", "--porcelain", "--", "packages"], root));
  hash.update(run("git", ["diff", "HEAD", "--", "packages"], root));
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard", "--", "packages"], root)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const file of untracked) {
    hash.update(file);
    try {
      hash.update(readFileSync(join(root, file)));
    } catch {
      // Vanished between listing and reading; the path alone still moves the key.
    }
  }
  return hash.digest("hex").slice(0, 16);
}

export function packVgpu({ outDir, build = true, log = () => {} } = {}) {
  const root = repoRoot();
  const byName = readWorkspacePackages(root);
  const closure = workspaceClosure(byName, ROOT_PACKAGE);
  const destination = resolve(outDir ?? join(PACKAGE_ROOT, ".work", "tarballs"));

  if (build) {
    const filters = [...closure, ...BUILD_ONLY].flatMap((name) => ["--filter", name]);
    log(`building ${closure.length + BUILD_ONLY.length} packages…`);
    run("pnpm", [...filters, "run", "build"], root);
  }

  // A stale tarball from a previous branch is worse than no tarball: it would
  // silently grade the wrong code.
  rmSync(destination, { force: true, recursive: true });
  mkdirSync(destination, { recursive: true });

  /** @type {{ name: string, version: string, file: string }[]} */
  const tarballs = [];
  for (const name of closure) {
    const { dir, pkg } = byName.get(name);
    log(`packing ${name}@${pkg.version}…`);
    run("pnpm", ["pack", "--pack-destination", destination], dir);
    const file = readdirSync(destination).find((candidate) => {
      const base = `${name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;
      return candidate === base;
    });
    if (!file) {
      throw new Error(
        `pack-vgpu: packed ${name}@${pkg.version} but found no tarball in ${destination} (got: ${readdirSync(destination).join(", ")})`,
      );
    }
    tarballs.push({ name, version: pkg.version, file });
  }

  const manifest = {
    packedAt: new Date().toISOString(),
    // Cache key and staleness guard. Deliberately NOT derived from packedAt or
    // from the tarball bytes — see sourceKey().
    sourceKey: sourceKey(),
    gitSha: run("git", ["rev-parse", "HEAD"], root).trim(),
    gitBranch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root).trim(),
    rootPackage: ROOT_PACKAGE,
    tarballs,
  };
  writeFileSync(join(destination, "tarballs.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { destination, manifest };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      "skip-build": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/pack-vgpu.mjs [--out <dir>] [--skip-build]\n\n" +
        "Packs this branch's vgpu (and its workspace dependency closure) into\n" +
        "installable tarballs, plus a tarballs.json manifest.\n",
    );
    process.exit(0);
  }
  const { destination, manifest } = packVgpu({
    outDir: values.out,
    build: !values["skip-build"],
    log: (message) => process.stdout.write(`pack-vgpu: ${message}\n`),
  });
  process.stdout.write(
    `pack-vgpu: ${manifest.tarballs.length} tarballs in ${destination} (${manifest.gitBranch} @ ${manifest.gitSha.slice(0, 8)})\n`,
  );
  for (const tarball of manifest.tarballs) {
    process.stdout.write(`  ${tarball.name}@${tarball.version} -> ${tarball.file}\n`);
  }
}
