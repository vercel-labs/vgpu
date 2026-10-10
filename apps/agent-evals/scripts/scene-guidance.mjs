#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sourceKey } from "./pack-vgpu.mjs";

export const DOCS_MANIFEST_TAR_PATH = "package/dist/cli/lib/generated/docs-manifest.generated.js";
const DOCS_MANIFEST_REPO_PATH = "packages/vgpu/lib/generated/docs-manifest.generated.js";
const BASELINE_GIT_REF = "a8a9bc8a";
const CURRENT_GIT_SHA = "929b97f5b13f3948c11d58e80464d402b77d64b2";
const EXPERIMENT = "scene-math-guidance-v1";
const MATH_DEPENDENCY = Object.freeze({ name: "math", version: "0.1.0" });
export const SCENE_EXPERIMENT_MODEL = "anthropic/claude-sonnet-5";
export const SCENE_EXPERIMENT_DOCKER_IMAGE =
  "ghcr.io/vercel/eve@sha256:de79f9a495add7cd1691e3496afc1c3227b0846f9ae0b26126f120c91af3445c";
export const SCENE_EXPERIMENT_MATH_INTEGRITY =
  "sha512-hq5KkLblFiR8OO8ZYqPK02mBqrXuxJ6hwvhL3ZM9OFkAR82/20n4H768SWl4yVVrufh8VijEm42D4V9N8hDa2g==";
const VARIANTS = Object.freeze(["baseline", "math"]);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseSceneExperimentEnv(env = process.env) {
  const rawVariant = env.VGPU_EVALS_SCENE_GUIDANCE;
  const variant = rawVariant === undefined || rawVariant === "" ? null : rawVariant;
  if (variant !== null && !VARIANTS.includes(variant)) {
    throw new Error(
      `VGPU_EVALS_SCENE_GUIDANCE invalid: ${JSON.stringify(rawVariant)} (expected "baseline" or "math")`,
    );
  }

  const rawRepetitions = env.VGPU_EVALS_SCENE_REPETITIONS;
  const repetitions = rawRepetitions === undefined || rawRepetitions === "" ? 1 : Number(rawRepetitions);
  if (!/^[12]$/.test(String(rawRepetitions ?? "1")) || !Number.isInteger(repetitions)) {
    throw new Error(
      `VGPU_EVALS_SCENE_REPETITIONS invalid: ${JSON.stringify(rawRepetitions)} (expected integer 1 or 2)`,
    );
  }
  return { variant, repetitions };
}

export function validateSceneExperimentRuntime({ variant }, env = process.env) {
  if (variant === null) return;
  if (env.VGPU_EVALS_MODEL !== SCENE_EXPERIMENT_MODEL) {
    throw new Error(`VGPU_EVALS_MODEL must be ${SCENE_EXPERIMENT_MODEL} in scene guidance experiment mode`);
  }
  if (env.VGPU_EVALS_DOCKER_IMAGE !== SCENE_EXPERIMENT_DOCKER_IMAGE) {
    throw new Error(
      `VGPU_EVALS_DOCKER_IMAGE must be ${SCENE_EXPERIMENT_DOCKER_IMAGE} in scene guidance experiment mode`,
    );
  }
}

export function normalizedPackageLockSha256(source) {
  let lock;
  try {
    lock = JSON.parse(source);
  } catch (error) {
    throw new Error(`package-lock.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const normalized = structuredClone(lock);
  const vgpuPackage = normalized.packages?.["node_modules/vgpu"];
  if (vgpuPackage && typeof vgpuPackage === "object") {
    if ("resolved" in vgpuPackage) vgpuPackage.resolved = "<assigned-vgpu-tarball>";
    if ("integrity" in vgpuPackage) vgpuPackage.integrity = "<assigned-vgpu-tarball>";
  }
  const vgpuDependency = normalized.dependencies?.vgpu;
  if (vgpuDependency && typeof vgpuDependency === "object") {
    if ("resolved" in vgpuDependency) vgpuDependency.resolved = "<assigned-vgpu-tarball>";
    if ("integrity" in vgpuDependency) vgpuDependency.integrity = "<assigned-vgpu-tarball>";
  }
  return sha256(JSON.stringify(normalized));
}

export function sceneExperimentInstallSpecs(manifest) {
  return manifest?.sceneGuidance ? [`${MATH_DEPENDENCY.name}@${MATH_DEPENDENCY.version}`] : [];
}

export function compareSceneGuidanceCorpora(baselineSource, currentSource) {
  const baseline = parseDocsManifest(baselineSource, "baseline");
  const current = parseDocsManifest(currentSource, "math");
  const baselineEnvelope = { ...baseline, records: undefined };
  const currentEnvelope = { ...current, records: undefined };
  if (JSON.stringify(baselineEnvelope) !== JSON.stringify(currentEnvelope)) {
    throw new Error("unexpected docs corpus change outside records");
  }

  const baselineRecords = recordMap(baseline.records, "baseline");
  const currentRecords = recordMap(current.records, "math");
  const added = [...currentRecords.keys()].filter((path) => !baselineRecords.has(path)).sort();
  const removed = [...baselineRecords.keys()].filter((path) => !currentRecords.has(path)).sort();
  const changed = [...currentRecords.keys()]
    .filter((path) => baselineRecords.has(path) && JSON.stringify(currentRecords.get(path)) !== JSON.stringify(baselineRecords.get(path)))
    .sort();

  if (JSON.stringify(added) !== JSON.stringify(["/guides/scene-math.docs.md#scene-math"])) {
    throw new Error(`unexpected docs corpus change: expected only scene-math addition, got ${JSON.stringify(added)}`);
  }
  if (removed.length > 0) throw new Error(`unexpected docs corpus removal: ${removed.join(", ")}`);
  if (JSON.stringify(changed) !== JSON.stringify(["/guides/scene-composition.docs.md#scene-composition"])) {
    throw new Error(
      `unexpected docs corpus change: expected only scene-composition content, got ${JSON.stringify(changed)}`,
    );
  }

  const mathRecord = currentRecords.get("/guides/scene-math.docs.md#scene-math");
  if (mathRecord?.symbol !== "scene-math" || mathRecord?.repoPath !== "docs/topics/scene-math.docs.md") {
    throw new Error("scene-math record identity does not match the accepted treatment");
  }
  const baselineComposition = baselineRecords.get("/guides/scene-composition.docs.md#scene-composition");
  const currentComposition = currentRecords.get("/guides/scene-composition.docs.md#scene-composition");
  const changedFields = Object.keys({ ...baselineComposition, ...currentComposition }).filter(
    (key) => JSON.stringify(baselineComposition?.[key]) !== JSON.stringify(currentComposition?.[key]),
  );
  if (JSON.stringify(changedFields) !== JSON.stringify(["content"])) {
    throw new Error(`scene-composition change must be content-only, got ${changedFields.join(", ")}`);
  }
  return { added, removed, changed };
}

export function prepareSceneGuidanceExperiment({ sourceTarballsDir, outputRoot, repoRoot } = {}) {
  const root = resolve(repoRoot ?? findRepoRoot(PACKAGE_ROOT));
  const sourceDirectory = resolve(sourceTarballsDir ?? join(PACKAGE_ROOT, ".work", "tarballs"));
  const manifest = readJson(join(sourceDirectory, "tarballs.json"));
  const currentKey = sourceKey();
  if (manifest.sourceKey !== currentKey) {
    throw new Error(`scene guidance source tarballs are stale: expected key ${currentKey}, got ${manifest.sourceKey}`);
  }
  const baselineGitSha = git(root, ["rev-parse", `${BASELINE_GIT_REF}^{commit}`]).trim();
  const baselineDocsSource = git(root, ["show", `${baselineGitSha}:${DOCS_MANIFEST_REPO_PATH}`]);
  const currentDocsSource = git(root, ["show", `${CURRENT_GIT_SHA}:${DOCS_MANIFEST_REPO_PATH}`]);
  return prepareSceneGuidanceFixture({
    sourceTarballsDir: sourceDirectory,
    outputRoot: resolve(outputRoot ?? join(PACKAGE_ROOT, ".work", "scene-guidance")),
    baselineDocsSource,
    currentDocsSource,
    baselineGitSha,
    currentGitSha: CURRENT_GIT_SHA,
  });
}

export function prepareSceneGuidanceFixture({
  sourceTarballsDir,
  outputRoot,
  baselineDocsSource,
  currentDocsSource,
  baselineGitSha,
  currentGitSha,
}) {
  const sourceDirectory = resolve(sourceTarballsDir);
  const outputDirectory = resolve(outputRoot);
  const sourceManifestPath = join(sourceDirectory, "tarballs.json");
  const sourceManifest = readJson(sourceManifestPath);
  if (!Array.isArray(sourceManifest.tarballs) || sourceManifest.tarballs.length === 0) {
    throw new Error("scene guidance source manifest has no tarballs");
  }
  const vgpuEntry = sourceManifest.tarballs.find((entry) => entry.name === "vgpu");
  if (!vgpuEntry || !safeFileName(vgpuEntry.file)) throw new Error("scene guidance source manifest has no safe vgpu tarball");
  const sourceVgpuTarball = join(sourceDirectory, vgpuEntry.file);
  const packedCurrentDocs = readTarEntry(sourceVgpuTarball, DOCS_MANIFEST_TAR_PATH).toString("utf8");
  if (packedCurrentDocs !== currentDocsSource) {
    throw new Error("packed vgpu docs manifest does not match the accepted current corpus bytes");
  }

  const comparison = compareSceneGuidanceCorpora(baselineDocsSource, currentDocsSource);
  const baselineDocsSha256 = sha256(baselineDocsSource);
  const currentDocsSha256 = sha256(currentDocsSource);
  const identity = [
    EXPERIMENT,
    sourceManifest.sourceKey,
    baselineDocsSha256.slice(0, 12),
    currentDocsSha256.slice(0, 12),
  ].join("-");
  const destination = join(outputDirectory, identity);
  if (existsSync(destination)) {
    return readPreparedFixture(destination, {
      sourceKey: sourceManifest.sourceKey,
      baselineDocsSha256,
      currentDocsSha256,
    });
  }

  mkdirSync(outputDirectory, { recursive: true });
  const staging = mkdtempSync(join(outputDirectory, ".scene-guidance-"));
  try {
    const auditRoot = join(staging, ".audit");
    const currentTree = join(auditRoot, "current");
    const baselineTree = join(auditRoot, "baseline");
    const repackedTree = join(auditRoot, "repacked");
    mkdirSync(currentTree, { recursive: true });
    mkdirSync(baselineTree, { recursive: true });
    mkdirSync(repackedTree, { recursive: true });
    extractTar(sourceVgpuTarball, currentTree);
    extractTar(sourceVgpuTarball, baselineTree);
    writeFileSync(
      join(baselineTree, ...DOCS_MANIFEST_TAR_PATH.split("/")),
      baselineDocsSource,
      "utf8",
    );

    const variantMetadata = {};
    for (const variant of VARIANTS) {
      const tarballsDirectory = join(staging, variant, "tarballs");
      mkdirSync(tarballsDirectory, { recursive: true });
      for (const entry of sourceManifest.tarballs) {
        if (!safeFileName(entry.file)) throw new Error(`unsafe tarball path ${String(entry.file)}`);
        copyFileSync(join(sourceDirectory, entry.file), join(tarballsDirectory, entry.file));
      }
      if (variant === "baseline") {
        createTar(baselineTree, join(tarballsDirectory, vgpuEntry.file));
        extractTar(join(tarballsDirectory, vgpuEntry.file), repackedTree);
        assertOnlyManifestChanged(currentTree, repackedTree);
        assertNoTreatmentLeak(repackedTree);
      }

      const docsSha256 = variant === "baseline" ? baselineDocsSha256 : currentDocsSha256;
      const counterpartDocsSha256 = variant === "baseline" ? currentDocsSha256 : baselineDocsSha256;
      const tarballs = sourceManifest.tarballs.map((entry) => ({
        ...entry,
        sha256: sha256(readFileSync(join(tarballsDirectory, entry.file))),
      }));
      const manifest = {
        ...sourceManifest,
        tarballs,
        sceneGuidance: {
          schemaVersion: 1,
          experiment: EXPERIMENT,
          variant,
          baselineGitSha,
          currentDocsGitSha: currentGitSha,
          runtimeGitSha: sourceManifest.gitSha ?? "unavailable",
          docsManifestPath: DOCS_MANIFEST_TAR_PATH,
          docsSha256,
          counterpartDocsSha256,
          dependency: MATH_DEPENDENCY,
          comparison,
          sourceTarballsManifestSha256: sha256(readFileSync(sourceManifestPath)),
        },
      };
      writeJson(join(tarballsDirectory, "tarballs.json"), manifest);
      validatePreparedSceneGuidanceVariant(tarballsDirectory, variant);
      variantMetadata[variant] = {
        tarballsPath: `${variant}/tarballs`,
        docsSha256,
        vgpuTarballSha256: tarballs.find((entry) => entry.name === "vgpu").sha256,
      };
    }

    mkdirSync(join(staging, "corpora"), { recursive: true });
    writeFileSync(join(staging, "corpora", "baseline-docs-manifest.generated.js"), baselineDocsSource, "utf8");
    writeFileSync(join(staging, "corpora", "math-docs-manifest.generated.js"), currentDocsSource, "utf8");
    rmSync(auditRoot, { recursive: true, force: true });
    writeJson(join(staging, "scene-guidance.json"), {
      schemaVersion: 1,
      experiment: EXPERIMENT,
      createdAt: new Date().toISOString(),
      sourceKey: sourceManifest.sourceKey,
      runtimeGitSha: sourceManifest.gitSha ?? "unavailable",
      baselineGitSha,
      currentDocsGitSha: currentGitSha,
      dependency: MATH_DEPENDENCY,
      docsManifestPath: DOCS_MANIFEST_TAR_PATH,
      comparison,
      variants: variantMetadata,
    });
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return readPreparedFixture(destination, {
    sourceKey: sourceManifest.sourceKey,
    baselineDocsSha256,
    currentDocsSha256,
  });
}

export function validatePreparedSceneGuidanceVariant(tarballsDirectory, expectedVariant) {
  if (!VARIANTS.includes(expectedVariant)) throw new Error(`unknown scene guidance variant ${expectedVariant}`);
  const directory = resolve(tarballsDirectory);
  const manifest = readJson(join(directory, "tarballs.json"));
  const guidance = manifest.sceneGuidance;
  if (guidance?.experiment !== EXPERIMENT || guidance?.variant !== expectedVariant) {
    throw new Error(`scene guidance variant mismatch: expected ${expectedVariant}`);
  }
  if (guidance?.dependency?.name !== MATH_DEPENDENCY.name || guidance?.dependency?.version !== MATH_DEPENDENCY.version) {
    throw new Error("scene guidance math dependency identity is invalid");
  }
  if (!Array.isArray(manifest.tarballs) || manifest.tarballs.length === 0) {
    throw new Error("scene guidance manifest has no tarballs");
  }
  for (const entry of manifest.tarballs) {
    if (!safeFileName(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
      throw new Error("scene guidance tarball manifest is missing a safe path or sha256");
    }
    const path = join(directory, entry.file);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`scene guidance tarball ${entry.file} is missing`);
    const actual = sha256(readFileSync(path));
    if (actual !== entry.sha256) throw new Error(`scene guidance tarball ${entry.file} sha256 mismatch (tamper or stale artifact)`);
  }
  const vgpuEntry = manifest.tarballs.find((entry) => entry.name === "vgpu");
  if (!vgpuEntry) throw new Error("scene guidance manifest has no vgpu tarball");
  const docsBytes = readTarEntry(join(directory, vgpuEntry.file), DOCS_MANIFEST_TAR_PATH);
  if (sha256(docsBytes) !== guidance.docsSha256) {
    throw new Error("scene guidance vgpu tarball docs sha256 mismatch");
  }
  return manifest;
}

export function readTarEntry(tarballPath, entryPath) {
  const result = spawnSync("tar", ["-xOzf", resolve(tarballPath), entryPath], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`could not read ${entryPath} from ${tarballPath}: ${String(result.stderr)}`);
  }
  return result.stdout;
}

function parseDocsManifest(source, label) {
  const prefix = "export const docsManifest = ";
  if (!source.startsWith(prefix) || !/;\s*$/.test(source)) {
    throw new Error(`${label} docs manifest is not the generated JSON module format`);
  }
  let parsed;
  try {
    parsed = JSON.parse(source.slice(prefix.length).replace(/;\s*$/, ""));
  } catch (error) {
    throw new Error(`${label} docs manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed.records)) throw new Error(`${label} docs manifest has no records array`);
  return parsed;
}

function recordMap(records, label) {
  const map = new Map();
  for (const record of records) {
    if (typeof record?.virtualPath !== "string") throw new Error(`${label} docs record has no virtualPath`);
    const anchor = typeof record.anchor === "string" && record.anchor.length > 0
      ? record.anchor
      : typeof record.symbol === "string" && record.symbol.length > 0
        ? record.symbol
        : null;
    if (anchor === null) throw new Error(`${label} docs record ${record.virtualPath} has no anchor identity`);
    const key = `${record.virtualPath}#${anchor}`;
    if (map.has(key)) throw new Error(`${label} docs corpus repeats ${key}`);
    map.set(key, record);
  }
  return map;
}

function readPreparedFixture(root, expected) {
  const manifest = readJson(join(root, "scene-guidance.json"));
  if (manifest.experiment !== EXPERIMENT || manifest.sourceKey !== expected.sourceKey) {
    throw new Error("existing scene guidance fixture identity is stale or corrupt");
  }
  if (manifest.variants?.baseline?.docsSha256 !== expected.baselineDocsSha256
    || manifest.variants?.math?.docsSha256 !== expected.currentDocsSha256) {
    throw new Error("existing scene guidance fixture corpus hashes are stale or corrupt");
  }
  const variants = {};
  for (const variant of VARIANTS) {
    const tarballsDir = join(root, manifest.variants[variant].tarballsPath);
    validatePreparedSceneGuidanceVariant(tarballsDir, variant);
    variants[variant] = { tarballsDir };
  }
  return { root, manifestPath: join(root, "scene-guidance.json"), manifest, variants };
}

function assertOnlyManifestChanged(currentRoot, baselineRoot) {
  const current = treeManifest(currentRoot);
  const baseline = treeManifest(baselineRoot);
  const paths = [...new Set([...current.keys(), ...baseline.keys()])].sort();
  const changed = paths.filter((path) => current.get(path) !== baseline.get(path));
  if (JSON.stringify(changed) !== JSON.stringify([DOCS_MANIFEST_TAR_PATH])) {
    throw new Error(`baseline vgpu tarball changed files outside the docs manifest: ${changed.join(", ")}`);
  }
}

function assertNoTreatmentLeak(root) {
  const markers = [
    "/guides/scene-math.docs.md",
    "docs/topics/scene-math.docs.md",
    "# Using math with scene data",
    "math@0.1.0",
  ];
  for (const path of regularFiles(root)) {
    const content = readFileSync(path, "utf8");
    const marker = markers.find((candidate) => content.includes(candidate));
    if (marker) {
      throw new Error(`baseline vgpu tarball still contains treatment corpus marker ${JSON.stringify(marker)} in ${path}`);
    }
  }
}

function treeManifest(root) {
  const manifest = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const key = relative(root, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isSymbolicLink()) manifest.set(key, `link:${readlinkSync(path)}`);
      else if (stat.isFile()) manifest.set(key, `file:${stat.mode & 0o7777}:${sha256(readFileSync(path))}`);
      else manifest.set(key, `other:${stat.mode}`);
    }
  };
  walk(root);
  return manifest;
}

function regularFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  return files;
}

function extractTar(tarballPath, destination) {
  const result = spawnSync("tar", ["-xzf", resolve(tarballPath), "-C", resolve(destination)], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`could not extract ${tarballPath}: ${result.stderr}`);
}

function createTar(sourceRoot, destination) {
  const result = spawnSync("tar", ["-czf", resolve(destination), "-C", resolve(sourceRoot), "package"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`could not create ${destination}: ${result.stderr}`);
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function findRepoRoot(from) {
  let directory = resolve(from);
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("could not find repository root");
    directory = parent;
  }
}

function safeFileName(file) {
  return typeof file === "string" && file.length > 0 && !file.includes("/") && !file.includes("\\") && file !== "..";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({
    options: {
      tarballs: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: node apps/agent-evals/scripts/scene-guidance.mjs [--tarballs <dir>] [--out <dir>]\n",
    );
    process.exit(0);
  }
  const fixture = prepareSceneGuidanceExperiment({
    sourceTarballsDir: values.tarballs,
    outputRoot: values.out,
  });
  process.stdout.write(`${fixture.manifestPath}\n`);
}
