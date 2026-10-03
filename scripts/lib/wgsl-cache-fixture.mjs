import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const OLD_WGSL_VERSION = "0.5.0";
const PUBLIC_REGISTRY = "https://registry.npmjs.org";

export function parseNextCacheArgs(args) {
  let next;
  let artifactDir;
  for (const argument of args) {
    if (argument.startsWith("--next=")) {
      if (next !== undefined) throw new Error("Pass --next only once.");
      next = argument.slice("--next=".length);
    } else if (argument.startsWith("--artifact-dir=")) {
      if (artifactDir !== undefined) throw new Error("Pass --artifact-dir only once.");
      artifactDir = argument.slice("--artifact-dir=".length);
      if (artifactDir.length === 0) throw new Error("--artifact-dir requires a path.");
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (next !== "15" && next !== "16") throw new Error("--next must be 15 or 16.");
  return {
    next: Number(next),
    artifactDir: resolve(artifactDir ?? `artifacts/wgsl-cache-next-${next}`),
  };
}

export function parseWebpackCacheArgs(args) {
  let artifactDir;
  for (const argument of args) {
    if (argument.startsWith("--artifact-dir=")) {
      if (artifactDir !== undefined) throw new Error("Pass --artifact-dir only once.");
      artifactDir = argument.slice("--artifact-dir=".length);
      if (artifactDir.length === 0) throw new Error("--artifact-dir requires a path.");
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { artifactDir: resolve(artifactDir ?? "artifacts/wgsl-cache-webpack") };
}

export async function createArtifactRun(artifactDir, prefix) {
  await mkdir(artifactDir, { recursive: true });
  const runDir = await mkdtemp(join(artifactDir, `${prefix}-`));
  const logPath = join(runDir, "commands.log");
  return { artifactDir, runDir, logPath };
}

export async function createFixtureRoot(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function run(command, args, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const label = options.label ?? `${command} ${args.join(" ")}`;
  if (options.logPath) {
    await appendFile(options.logPath, `\n$ ${command} ${args.join(" ")}\n[cwd] ${cwd}\n`);
  }
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!options.quiet) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!options.quiet) process.stderr.write(text);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
  if (options.logPath) {
    await appendFile(options.logPath, `${result.stdout}${result.stderr}[exit] ${result.code ?? result.signal}\n`);
  }
  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(`${label} failed (${result.signal ?? `exit ${result.code}`}). See ${options.logPath ?? "command output"}.`);
  }
  return result;
}

export async function acquirePackageArchives(runContext) {
  const archivesRoot = join(runContext.runDir, "archives");
  const oldRoot = join(archivesRoot, "npm-0.5.0");
  const candidateRoot = join(archivesRoot, "candidate");
  await Promise.all([mkdir(oldRoot, { recursive: true }), mkdir(candidateRoot, { recursive: true })]);

  const metadataResult = await run("npm", [
    "view",
    `@vgpu/wgsl@${OLD_WGSL_VERSION}`,
    "dist",
    "--json",
    `--registry=${PUBLIC_REGISTRY}`,
  ], {
    ...runContext,
    quiet: true,
    env: { npm_config_cache: join(runContext.runDir, "npm-cache") },
    label: "public npm metadata lookup",
  });
  const metadata = JSON.parse(metadataResult.stdout);
  assert.equal(metadata.tarball, `${PUBLIC_REGISTRY}/@vgpu/wgsl/-/wgsl-${OLD_WGSL_VERSION}.tgz`);
  assert.match(metadata.integrity, /^sha512-/u);

  const oldPackResult = await run("npm", [
    "pack",
    `@vgpu/wgsl@${OLD_WGSL_VERSION}`,
    "--json",
    "--pack-destination",
    oldRoot,
    `--registry=${PUBLIC_REGISTRY}`,
  ], {
    ...runContext,
    quiet: true,
    env: { npm_config_cache: join(runContext.runDir, "npm-cache") },
    label: "public npm archive acquisition",
  });
  const oldPack = JSON.parse(oldPackResult.stdout)[0];
  assert.equal(oldPack.name, "@vgpu/wgsl");
  assert.equal(oldPack.version, OLD_WGSL_VERSION);
  assert.equal(oldPack.integrity, metadata.integrity);
  const oldArchive = join(oldRoot, oldPack.filename);
  assert.equal(await integrity(oldArchive, "sha512"), metadata.integrity);
  assert.equal(await integrity(oldArchive, "sha1", false), metadata.shasum);

  await run("pnpm", [
    "--dir",
    join(repoRoot, "packages/wgsl"),
    "pack",
    "--pack-destination",
    candidateRoot,
  ], { ...runContext, label: "candidate @vgpu/wgsl pack" });
  await run("pnpm", [
    "--dir",
    join(repoRoot, "packages/wgsl-std"),
    "pack",
    "--pack-destination",
    candidateRoot,
  ], { ...runContext, label: "candidate @vgpu/wgsl-std pack" });
  const candidateFiles = await readdir(candidateRoot);
  const candidateArchive = join(candidateRoot, oneMatch(candidateFiles, /^vgpu-wgsl-\d.*\.tgz$/u));
  const candidateStdArchive = join(candidateRoot, oneMatch(candidateFiles, /^vgpu-wgsl-std-\d.*\.tgz$/u));
  const manifests = {
    old: JSON.parse(await tarText(oldArchive, "package/package.json")),
    candidate: JSON.parse(await tarText(candidateArchive, "package/package.json")),
    candidateStd: JSON.parse(await tarText(candidateStdArchive, "package/package.json")),
  };
  const manifestsPath = join(runContext.runDir, "package-manifests.json");
  await writeJson(manifestsPath, manifests);

  const receipt = {
    registry: PUBLIC_REGISTRY,
    manifests: relative(runContext.runDir, manifestsPath),
    old: {
      version: oldPack.version,
      resolved: metadata.tarball,
      integrity: metadata.integrity,
      shasum: metadata.shasum,
      sha256: await hashFile(oldArchive),
      archive: relative(runContext.runDir, oldArchive),
      fileCount: oldPack.entryCount,
      unpackedSize: oldPack.unpackedSize,
    },
    candidate: {
      wgsl: {
        version: JSON.parse(await tarText(candidateArchive, "package/package.json")).version,
        sha256: await hashFile(candidateArchive),
        archive: relative(runContext.runDir, candidateArchive),
      },
      std: {
        version: JSON.parse(await tarText(candidateStdArchive, "package/package.json")).version,
        sha256: await hashFile(candidateStdArchive),
        archive: relative(runContext.runDir, candidateStdArchive),
      },
    },
  };
  await writeJson(join(runContext.runDir, "archive-provenance.json"), receipt);
  await rm(join(runContext.runDir, "npm-cache"), { recursive: true, force: true });
  return { oldArchive, candidateArchive, candidateStdArchive, manifests, receipt };
}

export async function createCandidateVersionControlArchives({ archives, outputRoot, logPath }) {
  const sourceHashes = {
    historical: await hashFile(archives.oldArchive),
    candidate: await hashFile(archives.candidateArchive),
  };
  const historicalVersion = archives.manifests.old.version;
  const candidateVersion = archives.manifests.candidate.version;
  const differentVersion = candidateVersion === historicalVersion
    ? `${historicalVersion}-vgpu-cache-fixture.1`
    : candidateVersion;
  assert.notEqual(differentVersion, historicalVersion);
  await mkdir(outputRoot, { recursive: true });

  const root = await createFixtureRoot("vgpu-candidate-version-controls-");
  try {
    const sameVersionArchive = await createCandidateVersionControlArchive({
      archives,
      root,
      outputRoot,
      logPath,
      label: "same-version",
      version: historicalVersion,
    });
    const differentVersionArchive = await createCandidateVersionControlArchive({
      archives,
      root,
      outputRoot,
      logPath,
      label: "different-version",
      version: differentVersion,
    });
    assert.equal(await hashFile(archives.oldArchive), sourceHashes.historical, "Historical archive changed while creating version controls.");
    assert.equal(await hashFile(archives.candidateArchive), sourceHashes.candidate, "Candidate archive changed while creating version controls.");
    return {
      sameVersionArchive: sameVersionArchive.path,
      differentVersionArchive: differentVersionArchive.path,
      receipt: {
        scope: "disposable archives derived from candidate contents; source archives and repository manifests unchanged",
        sourceHashes,
        historicalVersion,
        candidateVersion,
        sameVersion: sameVersionArchive.receipt,
        differentVersion: differentVersionArchive.receipt,
      },
    };
  } finally {
    await disposeFixture(root);
  }
}

// Candidate companion packages may not be published yet (for example a prepared RC).
// Route only this candidate compiler's std dependency to the unmodified packed std;
// authentic historical installs continue to resolve their published dependencies.
export function candidatePackageOverrides(archives) {
  return {
    overrides: {
      [`@vgpu/wgsl@${archives.manifests.candidate.version}>@vgpu/wgsl-std`]: `file:${archives.candidateStdArchive}`,
    },
  };
}

export async function assertCandidateStd(root, archives) {
  const consumerRequire = createRequire(join(root, "package.json"));
  const compiler = await packageRoot(root, "@vgpu/wgsl");
  const compilerRequire = createRequire(join(compiler.resolved, "package.json"));
  assert.equal(
    await realpath(compilerRequire.resolve("@vgpu/wgsl-std/math")),
    await realpath(consumerRequire.resolve("@vgpu/wgsl-std/math")),
    "Candidate compiler must use the packed std companion, not a registry copy.",
  );
  const std = await packageRoot(root, "@vgpu/wgsl-std");
  const manifest = JSON.parse(await readFile(join(std.path, "package.json"), "utf8"));
  assert.equal(manifest.version, archives.manifests.candidateStd.version);
}

export async function installExternalConsumer({ root, packageJson, logPath }) {
  await mkdir(root, { recursive: true });
  await writeJson(join(root, "package.json"), packageJson);
  const storeDir = await realpath(await mkdtemp(join(tmpdir(), "vgpu-cache-pnpm-store-")));
  try {
    await run("pnpm", [
      "--dir",
      root,
      "install",
      "--store-dir",
      storeDir,
      "--config.package-import-method=copy",
      "--strict-peer-dependencies=false",
    ], { logPath, label: `isolated pnpm install in ${root}` });
  } catch (error) {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
  return { storeDir };
}

export async function replaceInstalledPackage(tarball, destination, fixtureRoot) {
  assertFixturePath(destination, fixtureRoot);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await run("tar", ["-xzf", tarball, "--strip-components=1", "-C", destination], {
    cwd: fixtureRoot,
    quiet: true,
    label: `extract ${basename(tarball)}`,
  });
}

export async function packageRoot(consumer, packageName) {
  const path = join(consumer, "node_modules", ...packageName.split("/"));
  const resolved = await realpath(path);
  assert.equal(isInside(repoRoot, resolved), false, `External package resolved into the repository: ${resolved}`);
  return { path, resolved };
}

export async function isolatedPackageManagerUpgrade({ root, archives, logPath }) {
  const base = {
    private: true,
    type: "module",
    dependencies: {
      "@vgpu/wgsl": `file:${archives.oldArchive}`,
    },
  };
  const { storeDir } = await installExternalConsumer({ root, packageJson: base, logPath });
  try {
    const old = await packageRoot(root, "@vgpu/wgsl");
    const oldManifest = JSON.parse(await readFile(join(old.path, "package.json"), "utf8"));
    assert.equal(oldManifest.version, OLD_WGSL_VERSION);
    assert.equal(oldManifest.version, archives.manifests.old.version);

    await writeJson(join(root, "package.json"), {
      ...base,
      pnpm: candidatePackageOverrides(archives),
      dependencies: {
        "@vgpu/wgsl": `file:${archives.candidateArchive}`,
        "@vgpu/wgsl-std": `file:${archives.candidateStdArchive}`,
      },
    });
    await run("pnpm", [
      "--dir",
      root,
      "install",
      // This disposable consumer deliberately changes its manifest to upgrade.
      // CI defaults to a frozen lockfile; the repository install stays frozen.
      "--no-frozen-lockfile",
      "--force",
      "--store-dir",
      storeDir,
      "--config.package-import-method=copy",
      "--strict-peer-dependencies=false",
    ], { logPath, label: "isolated pnpm old-to-candidate upgrade" });
    await assertCandidateStd(root, archives);
    const candidate = await packageRoot(root, "@vgpu/wgsl");
    const candidateManifest = JSON.parse(await readFile(join(candidate.path, "package.json"), "utf8"));
    assert.equal(candidateManifest.name, archives.manifests.candidate.name);
    assert.equal(candidateManifest.version, archives.manifests.candidate.version);
    assert.ok(candidateManifest.exports?.["./next"], "Candidate package must export @vgpu/wgsl/next.");
    return {
      manager: "pnpm",
      old: { version: oldManifest.version, path: old.path, realpath: old.resolved },
      candidate: {
        version: candidateManifest.version,
        archiveVersion: archives.manifests.candidate.version,
        versionRelation: candidateManifest.version === oldManifest.version ? "equal" : "different",
        path: candidate.path,
        realpath: candidate.resolved,
      },
      managerPathChanged: old.resolved !== candidate.resolved,
    };
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function verifyCandidateExports({ root, archives, logPath }) {
  const { storeDir } = await installExternalConsumer({
    root,
    logPath,
    packageJson: {
      private: true,
      type: "module",
      pnpm: candidatePackageOverrides(archives),
      dependencies: {
        "@vgpu/wgsl": `file:${archives.candidateArchive}`,
        "@vgpu/wgsl-std": `file:${archives.candidateStdArchive}`,
      },
    },
  });
  await rm(storeDir, { recursive: true, force: true, maxRetries: 3 });
  await assertCandidateStd(root, archives);
  const packageLocation = await packageRoot(root, "@vgpu/wgsl");
  const esm = await run(process.execPath, ["--input-type=module", "--eval", `
    import { wgslTurbopackRule } from "@vgpu/wgsl/next";
    const rule = wgslTurbopackRule();
    console.log(JSON.stringify({ loader: rule.loaders[0].loader, fingerprint: rule.loaders[0].options.vgpuImplementationFingerprint }));
  `], { cwd: root, logPath, quiet: true, label: "candidate ESM helper import" });
  const cjs = await run(process.execPath, ["--eval", `
    const { wgslTurbopackRule } = require("@vgpu/wgsl/next");
    const rule = wgslTurbopackRule({ minify: true });
    console.log(JSON.stringify({ loader: rule.loaders[0].loader, minify: rule.loaders[0].options.minify }));
  `], { cwd: root, logPath, quiet: true, label: "candidate CommonJS helper import" });
  const esmReceipt = JSON.parse(esm.stdout.trim());
  const cjsReceipt = JSON.parse(cjs.stdout.trim());
  assert.equal(isInside(packageLocation.resolved, await realpath(esmReceipt.loader)), true);
  assert.equal(isInside(packageLocation.resolved, await realpath(cjsReceipt.loader)), true);
  assert.match(esmReceipt.fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(cjsReceipt.minify, { whitespace: true, identifiers: "safe" });

  const typeProbe = join(root, "next-type-probe.ts");
  await writeFile(typeProbe, `
import { wgslTurbopackRule } from "@vgpu/wgsl/next";
import type { WgslTurbopackRule, WgslTurbopackRuleOptions } from "@vgpu/wgsl/next";
const options: WgslTurbopackRuleOptions = { minify: { whitespace: true, identifiers: "safe" } };
const rule: WgslTurbopackRule = wgslTurbopackRule(options);
const outputKind: "*.js" = rule.as;
const loader: string = rule.loaders[0].loader;
void outputKind;
void loader;
`);
  await writeJson(join(root, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    files: ["next-type-probe.ts"],
  });
  const typescriptManifest = JSON.parse(await readFile(join(repoRoot, "node_modules/typescript/package.json"), "utf8"));
  await run(process.execPath, [join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json")], {
    cwd: root,
    logPath,
    label: "candidate helper type compatibility",
  });

  // A sibling fixture prevents Node from finding the direct package in an ancestor.
  const nestedRoot = await createFixtureRoot("vgpu-nested-only-");
  try {
    const nestedPackage = join(nestedRoot, "node_modules/vgpu/node_modules/@vgpu/wgsl");
    const nestedStd = join(nestedRoot, "node_modules/vgpu/node_modules/@vgpu/wgsl-std");
    await Promise.all([
      replaceInstalledPackage(archives.candidateArchive, nestedPackage, nestedRoot),
      replaceInstalledPackage(archives.candidateStdArchive, nestedStd, nestedRoot),
      mkdir(join(nestedRoot, "node_modules/vgpu"), { recursive: true }),
    ]);
    await writeJson(join(nestedRoot, "package.json"), { private: true, type: "module" });
    await writeJson(join(nestedRoot, "node_modules/vgpu/package.json"), { name: "vgpu", version: "0.0.0", type: "module" });
    const negative = await run(process.execPath, ["--input-type=module", "--eval", "import('@vgpu/wgsl/next')"], {
      cwd: nestedRoot,
      logPath,
      quiet: true,
      allowFailure: true,
      label: "nested-only direct import negative control",
    });
    assert.notEqual(negative.code, 0, "A transitive-only @vgpu/wgsl install must not satisfy a root direct import.");
    assert.match(negative.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/u);
    const nestedPositive = await run(process.execPath, ["--input-type=module", "--eval", `
      import { createRequire } from "node:module";
      const require = createRequire(new URL("./node_modules/vgpu/package.json", import.meta.url));
      const helper = require("@vgpu/wgsl/next");
      console.log(JSON.stringify(helper.wgslTurbopackRule()));
    `], { cwd: nestedRoot, logPath, quiet: true, label: "nested dependency own-install helper import" });
    const nestedRule = JSON.parse(nestedPositive.stdout.trim());
    assert.equal(isInside(nestedPackage, await realpath(nestedRule.loaders[0].loader)), true);
    const fallbackEntry = join(nestedRoot, "wgsl-std-fallback.wgsl");
    await writeFile(fallbackEntry, 'import { pi } from "@vgpu/wgsl-std/constants";\n@compute @workgroup_size(1) fn main() { let value = pi; }\n');
    const fallback = await run(process.execPath, ["--input-type=module", "--eval", `
      import { resolveShader } from ${JSON.stringify(fixtureFileUrl(join(nestedPackage, "dist/runtime/resolve-shader.js")))};
      const result = await resolveShader({ entry: ${JSON.stringify(fallbackEntry)}, validate: false });
      console.log(JSON.stringify({ deps: result.deps, hasPi: result.wgsl.includes("3.1415927") }));
    `], { cwd: nestedRoot, logPath, quiet: true, label: "nested dependency WGSL std fallback" });
    const fallbackReceipt = JSON.parse(fallback.stdout.trim());
    assert.equal(fallbackReceipt.hasPi, true, "Nested candidate did not resolve @vgpu/wgsl-std through its own dependency layout.");
    assert.ok(fallbackReceipt.deps.some((path) => isInside(nestedStd, path)), "WGSL std fallback resolved outside the nested dependency copy.");
    return {
      directPackageRoot: packageLocation.resolved,
      esm: esmReceipt,
      cjs: cjsReceipt,
      types: { typescript: typescriptManifest.version, result: "passed" },
      nestedOnlyDirectImport: "failed as expected",
      nestedOwnInstallLoader: nestedRule.loaders[0].loader,
      nestedWgslStdFallback: fallbackReceipt,
    };
  } finally {
    await disposeFixture(nestedRoot);
  }
}

export async function writeCountingLoader(root, receiptPath) {
  const loader = join(root, "counting-loader.cjs");
  await writeFile(loader, `
const { appendFileSync } = require("node:fs");
module.exports = function vgpuCacheExecutionReceipt(source) {
  appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ pid: process.pid, resourcePath: this.resourcePath, time: Date.now() }) + "\\n");
  return source;
};
`);
  return loader;
}

export async function executionCount(path) {
  try {
    return (await readFile(path, "utf8")).split(/\r?\n/u).filter(Boolean).length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

export async function snapshotOnlyCache(outputDir, snapshotDir) {
  const cache = join(outputDir, "cache");
  await stat(cache);
  await rm(snapshotDir, { recursive: true, force: true });
  await cp(cache, snapshotDir, { recursive: true, preserveTimestamps: true });
  return hashTree(snapshotDir);
}

export async function restoreOnlyCache(outputDir, snapshotDir) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await cp(snapshotDir, join(outputDir, "cache"), { recursive: true, preserveTimestamps: true });
}

export async function hashFile(path, algorithm = "sha256") {
  return createHash(algorithm).update(await readFile(path)).digest("hex");
}

export async function hashTree(root, options = {}) {
  const files = await treeFiles(root, options.exclude ?? (() => false));
  const hash = createHash("sha256");
  hash.update("vgpu-wgsl-cache-fixture-tree-v1\0");
  let bytes = 0;
  for (const file of files) {
    const path = relative(root, file).replaceAll(sep, "/");
    const contents = await readFile(file);
    bytes += contents.byteLength;
    hash.update(`${Buffer.byteLength(path)}:${path}:${contents.byteLength}:`);
    hash.update(contents);
  }
  return { files: files.length, bytes, sha256: hash.digest("hex") };
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function assertHistoricalV1(value, label) {
  assert.equal(value?.version, 1, `${label} must be an authentic v1 artifact.`);
  assert.equal(Object.hasOwn(value, "reflection"), false, `${label} unexpectedly has reflection.`);
  assert.equal(Object.hasOwn(value, "sourceChecksum"), false, `${label} unexpectedly has sourceChecksum.`);
  assert.equal(Object.hasOwn(value, "producer"), false, `${label} unexpectedly has producer.`);
  assert.ok(Array.isArray(value.functionExports), `${label} must retain v1 functionExports.`);
}

export function assertPreparedV2(actual, expected, label) {
  assert.equal(actual?.version, 2, `${label} did not produce ShaderSource v2.`);
  assert.equal(actual?.producer, "@vgpu/wgsl/prepare-v2", `${label} has the wrong producer.`);
  assert.equal(typeof actual?.sourceChecksum, "string", `${label} is missing sourceChecksum.`);
  assert.ok(actual?.reflection && typeof actual.reflection === "object", `${label} is missing reflection.`);
  assert.ok(Array.isArray(actual?.functionExports), `${label} is missing functionExports.`);
  assert.deepEqual(actual, expected, `${label} differs from the independent prepared-v2 oracle.`);
}

export async function mutateFileOnce(path, search, replacement) {
  const original = await readFile(path, "utf8");
  assert.equal(original.split(search).length - 1, 1, `Expected exactly one compiler seam in ${path}.`);
  await writeFile(path, original.replace(search, replacement));
  return async () => writeFile(path, original);
}

export async function appendMutation(path, marker) {
  const original = await readFile(path);
  await writeFile(path, Buffer.concat([original, Buffer.from(`\n/* ${marker} */\n`)]));
  return async () => writeFile(path, original);
}

export async function disposeFixture(path) {
  const temporaryRoot = await realpath(tmpdir());
  assert.ok(path.startsWith(`${temporaryRoot}${sep}`), `Refusing to remove non-temporary fixture: ${path}`);
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
}

export function fixtureFileUrl(path) {
  return pathToFileURL(path).href;
}

async function integrity(path, algorithm, sri = true) {
  const digest = createHash(algorithm).update(await readFile(path)).digest(sri ? "base64" : "hex");
  return sri ? `${algorithm}-${digest}` : digest;
}

async function tarText(archive, member) {
  const result = await run("tar", ["-xOf", archive, member], { quiet: true, label: `read ${member}` });
  return result.stdout;
}

async function createCandidateVersionControlArchive({ archives, root, outputRoot, logPath, label, version }) {
  const packageRoot = join(root, label, "package");
  await replaceInstalledPackage(archives.candidateArchive, packageRoot, root);
  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.name, archives.manifests.candidate.name);
  manifest.version = version;
  await writeJson(manifestPath, manifest);
  const archive = join(outputRoot, `vgpu-wgsl-${label}.tgz`);
  await run("tar", ["-czf", archive, "-C", join(root, label), "package"], {
    logPath,
    quiet: true,
    label: `create ${label} candidate version-control archive`,
  });
  const archivedManifest = JSON.parse(await tarText(archive, "package/package.json"));
  assert.equal(archivedManifest.name, archives.manifests.candidate.name);
  assert.equal(archivedManifest.version, version);
  return {
    path: archive,
    receipt: {
      archive: relative(outputRoot, archive),
      sha256: await hashFile(archive),
      version,
    },
  };
}

function oneMatch(files, pattern) {
  const matches = files.filter((file) => pattern.test(file));
  assert.equal(matches.length, 1, `Expected one archive matching ${pattern}, found ${matches.join(", ")}.`);
  return matches[0];
}

function assertFixturePath(path, fixtureRoot) {
  const target = resolve(path);
  const root = resolve(fixtureRoot);
  assert.ok(target.startsWith(`${root}${sep}`), `Refusing fixture mutation outside ${root}: ${target}`);
}

function isInside(root, path) {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

async function treeFiles(root, exclude) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const rel = relative(root, path).replaceAll(sep, "/");
    if (exclude(rel, entry)) continue;
    if (entry.isDirectory()) result.push(...await treeFiles(path, (nested, nestedEntry) => exclude(`${rel}/${nested}`, nestedEntry)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
