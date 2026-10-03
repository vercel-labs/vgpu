import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  acquirePackageArchives,
  appendMutation,
  assertHistoricalV1,
  assertPreparedV2,
  createArtifactRun,
  createCandidateVersionControlArchives,
  createFixtureRoot,
  disposeFixture,
  executionCount,
  fixtureFileUrl,
  hashFile,
  hashTree,
  installExternalConsumer,
  mutateFileOnce,
  packageRoot,
  parseWebpackCacheArgs,
  replaceInstalledPackage,
  repoRoot,
  run,
  writeCountingLoader,
  writeJson,
} from "./lib/wgsl-cache-fixture.mjs";

const OBSERVABLE_PRODUCER_SUFFIX = "\n// vgpu-cache-observable-webpack-producer\n";

const options = parseWebpackCacheArgs(process.argv.slice(2));
const runContext = await createArtifactRun(options.artifactDir, "webpack");
const receipt = {
  status: "running",
  node: process.version,
  inputHead: null,
  artifactRun: relative(repoRoot, runContext.runDir),
  sourceRoot: repoRoot,
};
const fixtureRoots = [];

try {
  receipt.inputHead = await currentGitHead();
  const archives = await acquirePackageArchives(runContext);
  receipt.archives = archives.receipt;
  const versionControls = await createCandidateVersionControlArchives({
    archives,
    outputRoot: join(runContext.runDir, "archives/version-controls"),
    logPath: runContext.logPath,
  });
  receipt.archives.versionControls = versionControls.receipt;
  const fixture = await createWebpackConsumer(archives);
  receipt.webpack = fixture.webpackVersion;
  receipt.result = {
    cache: "webpack filesystem cache with default managedPaths",
    workers: "fresh Node process per compile; compiler.close completed before evaluation",
  };
  receipt.result.resolvedUpgrade = await authenticUpgradeScenario(fixture, archives, "resolved");
  await removeWebpackScenario(fixture, "resolved-upgrade");
  const bare = await bareUpgradeScenarios(fixture, archives, versionControls);
  receipt.result.bareUpgrade = bare.authenticUpgrade;
  receipt.result.bareSameVersionNegativeControl = bare.sameVersionNegativeControl;
  receipt.result.bareDifferentVersionControl = bare.differentVersionControl;
  receipt.result.bareSameVersionCacheClearRecovery = bare.sameVersionCacheClearRecovery;
  await removeWebpackScenario(fixture, "bare-upgrade");
  receipt.result.defaultManagedInstalledPackage = await dependencyMutationScenario(fixture, archives);
  await removeWebpackScenario(fixture, "raw-dependency");
  receipt.result.workspaceSymlink = await workspaceSymlinkScenario(fixture, archives);
  await removeWebpackScenario(fixture, "workspace-symlink");
  receipt.status = "passed";
  receipt.finishedAt = new Date().toISOString();
  await writeJson(join(runContext.runDir, "receipt.json"), receipt);
  console.log(`WGSL webpack cache receipt: ${join(runContext.runDir, "receipt.json")}`);
} catch (error) {
  receipt.status = "failed";
  receipt.finishedAt = new Date().toISOString();
  receipt.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
  await writeJson(join(runContext.runDir, "receipt.json"), receipt);
  throw error;
} finally {
  for (const root of fixtureRoots.reverse()) await disposeFixture(root);
}

async function authenticUpgradeScenario(fixture, archives, mode) {
  assert.notEqual(mode, "bare", "Bare upgrades require explicit version-aware controls.");
  await installOld(fixture, archives);
  const scenario = await createScenario(fixture, `${mode}-upgrade`, mode, false);
  const fixedBefore = await fixedIdentities(scenario);
  const physicalPackageRoot = await realpath(fixture.wgsl.path);
  const cold = await compileAndAssertV1(fixture, scenario, `${mode}-old-cold`);
  assertColdBuild(cold, `${mode} old cold`);
  const warm = await compileAndAssertV1(fixture, scenario, `${mode}-old-warm`);
  assertWarmReuse(cold, warm, `${mode} old warm`);
  const cacheBefore = await hashTree(scenario.cache);

  await installCandidate(fixture, archives);
  assert.equal(await realpath(fixture.wgsl.path), physicalPackageRoot, `${mode} upgrade moved the physical package root.`);
  await rm(scenario.output, { recursive: true, force: true });
  assert.deepEqual(await fixedIdentities(scenario), fixedBefore, `${mode} upgrade changed config or shaders.`);
  assert.deepEqual(await hashTree(scenario.cache), cacheBefore, `${mode} persistent cache changed before candidate compile.`);
  const upgraded = await compileAndAssertV2(fixture, scenario, `${mode}-candidate-upgrade`, false);
  assert.ok(upgraded.executions > warm.executions, `${mode} upgrade recovery did not execute the candidate loader.`);
  assertBuiltModules(upgraded, `${mode} authentic upgrade`);
  const candidateWarm = await compileAndAssertV2(fixture, scenario, `${mode}-candidate-warm`, false);
  assertWarmReuse(upgraded, candidateWarm, `${mode} candidate warm`);
  assertCompilerDependencies(upgraded, fixture.wgsl.path);
  return {
    fixed: fixedBefore,
    physicalPackageRoot,
    cacheBefore,
    oldCold: buildSummary(cold),
    oldWarm: buildSummary(warm),
    candidateUpgrade: buildSummary(upgraded),
    candidateWarm: buildSummary(candidateWarm),
    result: "authentic npm v1 rebuilt to exact prepared v2 with persistent cache retained",
  };
}

async function bareUpgradeScenarios(fixture, archives, versionControls) {
  await installOld(fixture, archives);
  const scenario = await createScenario(fixture, "bare-upgrade", "bare", false);
  const fixedBefore = await fixedIdentities(scenario);
  const physicalPackageRoot = await realpath(fixture.wgsl.path);
  const cold = await compileAndAssertV1(fixture, scenario, "bare-old-cold");
  assertColdBuild(cold, "bare old cold");
  const warm = await compileAndAssertV1(fixture, scenario, "bare-old-warm");
  assertWarmReuse(cold, warm, "bare old warm");
  const cacheBefore = await hashTree(scenario.cache);
  const oldCacheSnapshot = join(scenario.root, "old-cache-snapshot");
  await cp(scenario.cache, oldCacheSnapshot, { recursive: true, preserveTimestamps: true });

  const historicalVersion = archives.manifests.old.version;
  const candidateVersion = archives.manifests.candidate.version;
  await installCandidate(fixture, archives);
  await restoreWebpackCacheScenario(scenario, oldCacheSnapshot, cacheBefore);
  assert.equal(await realpath(fixture.wgsl.path), physicalPackageRoot, "Authentic bare upgrade moved the physical package root.");
  assert.deepEqual(await fixedIdentities(scenario), fixedBefore, "Authentic bare upgrade changed config or shaders.");
  const authenticVersionChanged = candidateVersion !== historicalVersion;
  let authentic;
  if (authenticVersionChanged) {
    const upgraded = await compileAndAssertV2(fixture, scenario, "bare-authentic-different-version-upgrade", false);
    assert.ok(upgraded.executions > warm.executions, "Different-version authentic bare upgrade did not execute the loader.");
    assertBuiltModules(upgraded, "different-version authentic bare upgrade");
    const upgradedWarm = await compileAndAssertV2(fixture, scenario, "bare-authentic-different-version-warm", false);
    assertWarmReuse(upgraded, upgradedWarm, "different-version authentic bare upgrade warm");
    authentic = {
      versionRelation: "different",
      historicalVersion,
      candidateVersion,
      upgrade: buildSummary(upgraded),
      warm: buildSummary(upgradedWarm),
      result: "authentic changed-version bare upgrade rebuilt exact prepared v2 with cache retained",
    };
  } else {
    const executionsBefore = await executionCount(scenario.executionReceipt);
    const stale = await compileAndAssertV1(fixture, scenario, "bare-authentic-same-version-observation");
    assertPersistentCacheReuse(stale, executionsBefore, "authentic same-version bare observation");
    authentic = {
      versionRelation: "equal",
      historicalVersion,
      candidateVersion,
      observation: buildSummary(stale),
      result: "authentic same-version bare replacement retained historical v1",
    };
  }

  await installCandidateArchive(fixture, archives, versionControls.sameVersionArchive);
  await restoreWebpackCacheScenario(scenario, oldCacheSnapshot, cacheBefore);
  const sameVersionExecutionsBefore = await executionCount(scenario.executionReceipt);
  const sameVersionStale = await compileAndAssertV1(fixture, scenario, "bare-control-same-version-negative");
  assertPersistentCacheReuse(sameVersionStale, sameVersionExecutionsBefore, "isolated same-version bare negative control");
  const sameVersionNegativeControl = {
    scope: "isolated disposable candidate archive; authentic archives and repository versions unchanged",
    historicalVersion,
    candidateVersion: versionControls.receipt.sameVersion.version,
    expectedLimitation: "same-version bare replacement retained historical v1",
    result: buildSummary(sameVersionStale),
  };

  await installCandidateArchive(fixture, archives, versionControls.differentVersionArchive);
  await restoreWebpackCacheScenario(scenario, oldCacheSnapshot, cacheBefore);
  const differentVersionExecutionsBefore = await executionCount(scenario.executionReceipt);
  const differentVersion = await compileAndAssertV2(fixture, scenario, "bare-control-different-version-upgrade", false);
  assert.ok(differentVersion.executions > differentVersionExecutionsBefore, "Isolated different-version bare control did not execute the loader.");
  assertBuiltModules(differentVersion, "isolated different-version bare control");
  const differentVersionWarm = await compileAndAssertV2(fixture, scenario, "bare-control-different-version-warm", false);
  assertWarmReuse(differentVersion, differentVersionWarm, "isolated different-version bare control warm");
  const differentVersionControl = {
    scope: "isolated disposable candidate archive; authentic archives and repository versions unchanged",
    historicalVersion,
    candidateVersion: versionControls.receipt.differentVersion.version,
    upgrade: buildSummary(differentVersion),
    warm: buildSummary(differentVersionWarm),
  };

  await installCandidateArchive(fixture, archives, versionControls.sameVersionArchive);
  await rm(scenario.cache, { recursive: true, force: true });
  await rm(scenario.output, { recursive: true, force: true });
  const recoveryExecutionsBefore = await executionCount(scenario.executionReceipt);
  const recovered = await compileAndAssertV2(fixture, scenario, "bare-control-same-version-after-cache-clear", false);
  assert.ok(recovered.executions > recoveryExecutionsBefore, "Same-version bare cache-clear recovery did not execute the loader.");
  assertBuiltModules(recovered, "same-version bare cache-clear recovery");
  const recoveredWarm = await compileAndAssertV2(fixture, scenario, "bare-control-same-version-recovery-warm", false);
  assertWarmReuse(recovered, recoveredWarm, "same-version bare cache-clear recovery warm");

  return {
    authenticUpgrade: authentic,
    sameVersionNegativeControl,
    differentVersionControl,
    sameVersionCacheClearRecovery: {
      recovery: "one-time removal of the historical persistent cache",
      rebuilt: buildSummary(recovered),
      warm: buildSummary(recoveredWarm),
    },
  };
}

async function dependencyMutationScenario(fixture, archives) {
  await installCandidate(fixture, archives);
  const minify = { whitespace: true };
  const scenario = await createScenario(fixture, "raw-dependency", "resolved", minify);
  const descriptor = await readFile(scenario.descriptor, "utf8");
  assert.doesNotMatch(descriptor, /wgslTurbopackRule|vgpuImplementationFingerprint/u);

  const cold = await compileAndAssertV2(fixture, scenario, "raw-dependency-cold", minify);
  assertColdBuild(cold, "raw dependency cold");
  assertCompilerDependencies(cold, fixture.wgsl.path);
  assertShaderDependencies(cold, scenario);
  const warm = await compileAndAssertV2(fixture, scenario, "raw-dependency-warm", minify);
  assertWarmReuse(cold, warm, "raw dependency warm");

  const transitive = join(fixture.wgsl.path, "dist/runtime/minify.js");
  const transitiveBefore = await hashFile(transitive);
  const restoreTransitive = await appendMutation(transitive, "vgpu webpack managed same-version negative control");
  const transitiveChanged = await hashFile(transitive);
  assert.notEqual(transitiveChanged, transitiveBefore, "Same-version negative control did not mutate the installed compiler helper.");
  const sameVersionIgnored = await compileAndAssertV2(fixture, scenario, "raw-dependency-same-version-negative", minify);
  assertWarmReuse(warm, sameVersionIgnored, "default managed same-version installed-package negative control");
  assert.deepEqual(sameVersionIgnored.artifacts, warm.artifacts, "Same-version managed-package negative control changed cached artifacts.");
  await restoreTransitive();
  assert.equal(await hashFile(transitive), transitiveBefore, "Same-version negative-control bytes did not restore.");

  const producer = join(fixture.wgsl.path, "dist/loader-shared/emit.js");
  const producerBefore = await hashFile(producer);
  const restoreProducer = await mutateObservableProducer(producer);
  const producerChanged = await hashFile(producer);
  assert.notEqual(producerChanged, producerBefore, "Version-change control did not mutate the installed compiler producer.");
  const manifestMutation = await mutateInstalledPackageVersion(fixture.wgsl.path);
  const versionChanged = await compileAndAssertV2(
    fixture,
    scenario,
    "raw-dependency-fixture-version-changed",
    minify,
    { wgslSuffix: OBSERVABLE_PRODUCER_SUFFIX },
  );
  assert.ok(versionChanged.executions > sameVersionIgnored.executions, "Default managed snapshots ignored the fixture-only package version change.");
  assertBuiltModules(versionChanged, "fixture-only package version change");
  assert.notDeepEqual(versionChanged.artifacts, warm.artifacts, "Version-change control did not use the observably changed producer.");
  const versionWarm = await compileAndAssertV2(
    fixture,
    scenario,
    "raw-dependency-fixture-version-warm",
    minify,
    { wgslSuffix: OBSERVABLE_PRODUCER_SUFFIX },
  );
  assertWarmReuse(versionChanged, versionWarm, "fixture-only changed-version warm");

  await restoreProducer();
  await manifestMutation.restore();
  assert.equal(await hashFile(producer), producerBefore, "Version-change producer bytes did not restore.");
  assert.equal(await hashFile(manifestMutation.path), manifestMutation.beforeHash, "Fixture package manifest bytes did not restore.");
  const versionRestored = await compileAndAssertV2(fixture, scenario, "raw-dependency-version-restored", minify);
  assert.ok(versionRestored.executions > versionChanged.executions, "Restoring the fixture package version did not rebuild.");
  assertBuiltModules(versionRestored, "fixture package version restored");
  assert.deepEqual(versionRestored.artifacts, warm.artifacts, "Restoring version and producer did not restore exact prepared artifacts.");
  const finalWarm = await compileAndAssertV2(fixture, scenario, "raw-dependency-final-warm", minify);
  assertWarmReuse(versionRestored, finalWarm, "raw dependency final warm");
  return {
    mechanism: "raw loader addBuildDependency; helper fingerprint absent; webpack default managedPaths retained",
    cold: buildSummary(cold),
    warm: buildSummary(warm),
    sameVersionInstalledPackage: {
      expectedLimitation: "default managed package snapshot ignored an internal same-version compiler edit",
      packageVersion: manifestMutation.originalVersion,
      transitiveBefore,
      transitiveChanged,
      result: buildSummary(sameVersionIgnored),
    },
    fixtureOnlyVersionChange: {
      scope: "disposable installed package copy; authentic archives and repository versions unchanged",
      originalVersion: manifestMutation.originalVersion,
      changedVersion: manifestMutation.changedVersion,
      producerBefore,
      producerChanged,
      changed: buildSummary(versionChanged),
      warm: buildSummary(versionWarm),
      restored: buildSummary(versionRestored),
    },
    finalWarm: buildSummary(finalWarm),
  };
}

async function workspaceSymlinkScenario(fixture, archives) {
  await installCandidate(fixture, archives);
  const nodeModulesPackage = join(fixture.root, "node_modules/@vgpu/wgsl");
  const workspacePackage = join(fixture.root, "workspace-packages/@vgpu/wgsl");
  await replaceInstalledPackage(archives.candidateArchive, workspacePackage, fixture.root);
  await rm(nodeModulesPackage, { recursive: true, force: true });
  await mkdir(join(fixture.root, "node_modules/@vgpu"), { recursive: true });
  await symlink(workspacePackage, nodeModulesPackage, "dir");
  assert.equal(await realpath(nodeModulesPackage), await realpath(workspacePackage), "Workspace package symlink did not resolve outside node_modules.");
  fixture.wgsl = { path: workspacePackage, resolved: await realpath(workspacePackage) };

  const manifest = JSON.parse(await readFile(join(workspacePackage, "package.json"), "utf8"));
  const minify = { whitespace: true };
  const scenario = await createScenario(fixture, "workspace-symlink", "resolved", minify);
  const cold = await compileAndAssertV2(fixture, scenario, "workspace-symlink-cold", minify);
  assertColdBuild(cold, "workspace symlink cold");
  assertCompilerDependencies(cold, workspacePackage);
  assertShaderDependencies(cold, scenario);
  const warm = await compileAndAssertV2(fixture, scenario, "workspace-symlink-warm", minify);
  assertWarmReuse(cold, warm, "workspace symlink warm");

  const producer = join(workspacePackage, "dist/loader-shared/emit.js");
  const producerBefore = await hashFile(producer);
  const restoreProducer = await mutateObservableProducer(producer);
  const producerChanged = await hashFile(producer);
  const changed = await compileAndAssertV2(
    fixture,
    scenario,
    "workspace-symlink-same-version-changed",
    minify,
    { wgslSuffix: OBSERVABLE_PRODUCER_SUFFIX },
  );
  assert.ok(changed.executions > warm.executions, "Webpack ignored a same-version compiler edit in the workspace symlink package.");
  assertBuiltModules(changed, "workspace symlink same-version changed");
  assert.notDeepEqual(changed.artifacts, warm.artifacts, "Workspace compiler edit did not change exact prepared artifacts.");
  const changedWarm = await compileAndAssertV2(
    fixture,
    scenario,
    "workspace-symlink-same-version-warm",
    minify,
    { wgslSuffix: OBSERVABLE_PRODUCER_SUFFIX },
  );
  assertWarmReuse(changed, changedWarm, "workspace symlink changed warm");

  await restoreProducer();
  assert.equal(await hashFile(producer), producerBefore, "Workspace producer bytes did not restore.");
  const restored = await compileAndAssertV2(fixture, scenario, "workspace-symlink-restored", minify);
  assert.ok(restored.executions > changed.executions, "Webpack ignored restoration in the workspace symlink package.");
  assertBuiltModules(restored, "workspace symlink restored");
  assert.deepEqual(restored.artifacts, warm.artifacts, "Workspace producer restoration did not restore exact prepared artifacts.");
  const finalWarm = await compileAndAssertV2(fixture, scenario, "workspace-symlink-final-warm", minify);
  assertWarmReuse(restored, finalWarm, "workspace symlink final warm");
  return {
    mechanism: "default webpack snapshots with a package symlink whose physical root is outside node_modules",
    packageVersion: manifest.version,
    nodeModulesPackage,
    physicalPackageRoot: workspacePackage,
    producerBefore,
    producerChanged,
    cold: buildSummary(cold),
    warm: buildSummary(warm),
    changed: buildSummary(changed),
    changedWarm: buildSummary(changedWarm),
    restored: buildSummary(restored),
    finalWarm: buildSummary(finalWarm),
  };
}

async function createWebpackConsumer(archives) {
  const root = await fixtureRoot("vgpu-webpack-cache-");
  const require = createRequire(join(repoRoot, "packages/wgsl/package.json"));
  const webpackVersion = require("webpack/package.json").version;
  const { storeDir } = await installExternalConsumer({
    root,
    logPath: runContext.logPath,
    packageJson: {
      private: true,
      type: "module",
      dependencies: {
        "@vgpu/wgsl": `file:${archives.oldArchive}`,
        "@vgpu/wgsl-std": "0.5.0",
        webpack: webpackVersion,
      },
    },
  });
  await rm(storeDir, { recursive: true, force: true });
  const wgsl = await packageRoot(root, "@vgpu/wgsl");
  const std = await packageRoot(root, "@vgpu/wgsl-std");
  const oldStdSnapshot = join(root, "old-wgsl-std-snapshot");
  await cp(std.path, oldStdSnapshot, { recursive: true, dereference: true, preserveTimestamps: true });
  const worker = join(root, "webpack-worker.mjs");
  await writeFile(worker, webpackWorkerSource());
  return { root, wgsl, std, oldStdSnapshot, worker, webpackVersion };
}

async function installOld(fixture, archives) {
  await replaceInstalledPackage(archives.oldArchive, fixture.wgsl.path, fixture.root);
  await rm(fixture.std.path, { recursive: true, force: true });
  await cp(fixture.oldStdSnapshot, fixture.std.path, { recursive: true, dereference: true, preserveTimestamps: true });
}

async function installCandidate(fixture, archives) {
  await replaceInstalledPackage(archives.candidateArchive, fixture.wgsl.path, fixture.root);
  await replaceInstalledPackage(archives.candidateStdArchive, fixture.std.path, fixture.root);
}

async function installCandidateArchive(fixture, archives, archive) {
  await replaceInstalledPackage(archive, fixture.wgsl.path, fixture.root);
  await replaceInstalledPackage(archives.candidateStdArchive, fixture.std.path, fixture.root);
}

async function restoreWebpackCacheScenario(scenario, snapshot, expectedHash) {
  await rm(scenario.output, { recursive: true, force: true });
  await rm(scenario.cache, { recursive: true, force: true });
  await cp(snapshot, scenario.cache, { recursive: true, preserveTimestamps: true });
  assert.deepEqual(await hashTree(scenario.cache), expectedHash, "Restored historical webpack cache bytes changed before replay.");
}

async function createScenario(fixture, name, mode, minify) {
  const root = join(fixture.root, "scenarios", name);
  const source = join(root, "src");
  const output = join(root, "dist");
  const cache = join(root, ".cache/webpack");
  const descriptor = join(root, "webpack-fixture.json");
  const executionReceipt = join(root, "loader-executions.jsonl");
  await mkdir(source, { recursive: true });
  const countingLoader = await writeCountingLoader(root, executionReceipt);
  await Promise.all([
    writeJson(join(root, "package.json"), { private: true, type: "module" }),
    writeJson(descriptor, { mode, minify, countingLoader }),
    writeFile(join(source, "entry.js"), 'import literal from "./literal.wgsl";\nimport graph from "./shader.wgsl";\nimport compact from "./compact.wgsl";\nexport default [literal, graph, compact];\n'),
    writeFile(join(source, "literal.wgsl"), literalShader()),
    writeFile(join(source, "shader.wgsl"), graphShader()),
    writeFile(join(source, "helper.wgsl"), helperShader()),
    writeFile(join(source, "compact.wgsl"), compactShader()),
  ]);
  return { root, source, output, cache, descriptor, executionReceipt, countingLoader, mode, minify };
}

async function compileAndAssertV1(fixture, scenario, label) {
  const result = await webpackCompile(fixture, scenario, label);
  for (const [index, artifact] of result.artifacts.entries()) assertHistoricalV1(artifact, `${label}[${index}]`);
  await writeJson(join(runContext.runDir, "artifacts", `${label}-actual.json`), result.artifacts);
  return result;
}

async function compileAndAssertV2(fixture, scenario, label, minify, oracleOptions = {}) {
  const result = await webpackCompile(fixture, scenario, label);
  const expected = await oracleArtifacts(fixture, scenario, minify, oracleOptions);
  await Promise.all([
    writeJson(join(runContext.runDir, "artifacts", `${label}-actual.json`), result.artifacts),
    writeJson(join(runContext.runDir, "artifacts", `${label}-expected.json`), expected),
  ]);
  assert.equal(result.artifacts.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assertPreparedV2(result.artifacts[index], expected[index], `${label}[${index}]`);
  }
  return result;
}

async function webpackCompile(fixture, scenario, label) {
  const statsPath = join(runContext.runDir, "stats", `${label}.json`);
  await mkdir(join(runContext.runDir, "stats"), { recursive: true });
  const input = {
    consumerRoot: fixture.root,
    scenarioRoot: scenario.root,
    source: scenario.source,
    output: scenario.output,
    cache: scenario.cache,
    descriptor: scenario.descriptor,
    countingLoader: scenario.countingLoader,
    mode: scenario.mode,
    minify: scenario.minify,
    statsPath,
    worker: fixture.worker,
  };
  await run(process.execPath, [fixture.worker], {
    cwd: fixture.root,
    logPath: runContext.logPath,
    env: { VGPU_WEBPACK_INPUT: JSON.stringify(input) },
    label,
  });
  const stats = JSON.parse(await readFile(statsPath, "utf8"));
  assert.equal(stats.closed, true, `${label} did not close the webpack compiler.`);
  const evaluated = await run(process.execPath, ["--eval", `
    const value = require(${JSON.stringify(join(scenario.output, "bundle.cjs"))});
    console.log(JSON.stringify({ pid: process.pid, artifacts: value.default ?? value }));
  `], { cwd: fixture.root, logPath: runContext.logPath, quiet: true, label: `${label} evaluation` });
  const evaluation = JSON.parse(evaluated.stdout.trim());
  assert.notEqual(evaluation.pid, stats.pid, `${label} evaluated in the compiler worker.`);
  return {
    artifacts: evaluation.artifacts,
    executions: await executionCount(scenario.executionReceipt),
    stats,
    evaluationPid: evaluation.pid,
  };
}

async function oracleArtifacts(fixture, scenario, minify, options = {}) {
  const specs = [
    { path: join(scenario.source, "literal.wgsl"), graph: false },
    { path: join(scenario.source, "shader.wgsl"), graph: true },
    { path: join(scenario.source, "compact.wgsl"), graph: false },
  ];
  const code = `
import { readFile } from "node:fs/promises";
import { applyMinifyWgsl } from ${JSON.stringify(fixtureFileUrl(join(fixture.wgsl.path, "dist/runtime/minify.js")))};
import { prepareShader } from ${JSON.stringify(fixtureFileUrl(join(fixture.wgsl.path, "dist/prepare.js")))};
import { resolveShader } from ${JSON.stringify(fixtureFileUrl(join(fixture.wgsl.path, "dist/runtime/resolve-shader.js")))};
const specs = JSON.parse(process.env.VGPU_ORACLE_SPECS);
const minify = JSON.parse(process.env.VGPU_ORACLE_MINIFY);
const wgslSuffix = process.env.VGPU_ORACLE_WGSL_SUFFIX;
const artifacts = [];
for (const spec of specs) {
  const source = await readFile(spec.path, "utf8");
  if (spec.graph) {
    const resolved = await resolveShader({ entry: spec.path, validate: false, minify });
    artifacts.push(prepareShader({ wgsl: resolved.wgsl + wgslSuffix, functionExports: resolved.functionExports }, spec.path));
  } else {
    artifacts.push(prepareShader({ wgsl: applyMinifyWgsl(source, minify) + wgslSuffix, functionExports: [] }, spec.path));
  }
}
console.log(JSON.stringify(artifacts));
`;
  const result = await run(process.execPath, ["--input-type=module", "--eval", code], {
    cwd: scenario.root,
    logPath: runContext.logPath,
    quiet: true,
    env: {
      VGPU_ORACLE_SPECS: JSON.stringify(specs),
      VGPU_ORACLE_MINIFY: JSON.stringify(minify),
      VGPU_ORACLE_WGSL_SUFFIX: options.wgslSuffix ?? "",
    },
    label: "webpack independent prepared-v2 oracle",
  });
  return JSON.parse(result.stdout.trim());
}

async function fixedIdentities(scenario) {
  return {
    descriptor: await hashFile(scenario.descriptor),
    source: await hashTree(scenario.source),
    root: scenario.root,
  };
}

async function mutateObservableProducer(path) {
  return mutateFileOnce(
    path,
    "const prepared = prepareShader({ wgsl, functionExports }, path);",
    `const prepared = prepareShader({ wgsl: wgsl + ${JSON.stringify(OBSERVABLE_PRODUCER_SUFFIX)}, functionExports }, path);`,
  );
}

async function mutateInstalledPackageVersion(wgslRoot) {
  const path = join(wgslRoot, "package.json");
  const original = await readFile(path);
  const beforeHash = await hashFile(path);
  const manifest = JSON.parse(original.toString("utf8"));
  const originalVersion = manifest.version;
  assert.equal(typeof originalVersion, "string");
  const changedVersion = `${originalVersion}-vgpu-cache-fixture.1`;
  manifest.version = changedVersion;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.notEqual(await hashFile(path), beforeHash, "Fixture package version mutation did not change the manifest.");
  return {
    path,
    beforeHash,
    originalVersion,
    changedVersion,
    restore: async () => writeFile(path, original),
  };
}

function assertColdBuild(result, label) {
  assert.ok(result.executions > 0, `${label} did not execute the fixture loader.`);
  assertBuiltModules(result, label);
}

function assertBuiltModules(result, label) {
  assert.ok(result.stats.wgslModules.length >= 3, `${label} did not report all WGSL modules.`);
  assert.ok(result.stats.wgslModules.some((module) => module.built === true), `${label} did not report built WGSL modules.`);
}

function assertWarmReuse(previous, warm, label) {
  assert.notEqual(warm.stats.pid, previous.stats.pid, `${label} reused a compiler process.`);
  assertPersistentCacheReuse(warm, previous.executions, label);
}

function assertPersistentCacheReuse(result, expectedExecutions, label) {
  assert.equal(result.executions, expectedExecutions, `${label} executed the loader instead of reusing cached work.`);
  assert.ok(result.stats.wgslModules.length >= 3, `${label} did not report cached WGSL modules.`);
  assert.ok(result.stats.wgslModules.every((module) => module.built !== true), `${label} rebuilt a WGSL module.`);
  assert.ok(result.stats.wgslModules.some((module) => module.cached === true), `${label} did not report a cached WGSL module.`);
}

function assertCompilerDependencies(result, wgslRoot) {
  const normalizedRoot = wgslRoot.replaceAll("\\", "/");
  const dependencies = result.stats.buildDependencies.map((path) => path.replaceAll("\\", "/"));
  assert.ok(dependencies.some((path) => path.startsWith(`${normalizedRoot}/dist/loader-shared/`)), "Webpack build dependencies omit loader-shared compiler files.");
  assert.ok(dependencies.some((path) => path.startsWith(`${normalizedRoot}/dist/runtime/`)), "Webpack build dependencies omit transitive runtime compiler files.");
  assert.ok(dependencies.includes(`${normalizedRoot}/package.json`), "Webpack build dependencies omit the compiler manifest.");
  assert.ok(dependencies.includes(`${normalizedRoot}/src/metadata.wgsl`), "Webpack build dependencies omit the metadata anchor.");
}

function assertShaderDependencies(result, scenario) {
  const helper = join(scenario.source, "helper.wgsl").replaceAll("\\", "/");
  assert.ok(result.stats.fileDependencies.map((path) => path.replaceAll("\\", "/")).includes(helper), "Webpack file dependencies omit the transitive shader import.");
}

function buildSummary(result) {
  return {
    compilerPid: result.stats.pid,
    evaluationPid: result.evaluationPid,
    executions: result.executions,
    wgslModules: result.stats.wgslModules,
    buildDependencies: result.stats.buildDependencies.length,
    fileDependencies: result.stats.fileDependencies.length,
    closed: result.stats.closed,
  };
}

async function currentGitHead() {
  const result = await run("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    logPath: runContext.logPath,
    quiet: true,
    label: "record input git HEAD",
  });
  const head = result.stdout.trim();
  assert.match(head, /^[0-9a-f]{40}$/u);
  return head;
}

async function removeWebpackScenario(fixture, name) {
  await rm(join(fixture.root, "scenarios", name), { recursive: true, force: true });
}

function webpackWorkerSource() {
  return `
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const input = JSON.parse(process.env.VGPU_WEBPACK_INPUT);
const require = createRequire(input.consumerRoot + "/package.json");
const webpack = require("webpack");
const loader = input.mode === "bare" ? "@vgpu/wgsl/loader-webpack" : require.resolve("@vgpu/wgsl/loader-webpack");
const compiler = webpack({
  context: input.scenarioRoot,
  mode: "development",
  target: "node",
  entry: "./src/entry.js",
  output: { path: input.output, filename: "bundle.cjs", library: { type: "commonjs2" }, clean: true },
  cache: {
    type: "filesystem",
    cacheDirectory: input.cache,
    name: "vgpu-wgsl-cache-fixture",
    buildDependencies: { config: [input.worker, input.descriptor] },
  },
  module: {
    rules: [{
      test: /\\.wgsl$/,
      use: [
        { loader: input.countingLoader },
        { loader, options: { minify: input.minify } },
      ],
    }],
  },
  optimization: { minimize: false },
  infrastructureLogging: { level: "error" },
});
let closed = false;
const stats = await new Promise((resolve, reject) => {
  compiler.run((error, value) => {
    compiler.close((closeError) => {
      closed = true;
      if (error || closeError) reject(error ?? closeError);
      else resolve(value);
    });
  });
});
const json = stats.toJson({ all: false, errors: true, warnings: true, modules: true, cachedModules: true, ids: false, reasons: false });
const modules = [];
const visit = (items = []) => {
  for (const item of items) {
    modules.push(item);
    visit(item.modules);
  }
};
visit(json.modules);
const result = {
  pid: process.pid,
  closed,
  hash: stats.hash,
  errors: json.errors,
  warnings: json.warnings,
  wgslModules: modules.filter((item) => String(item.name ?? item.identifier ?? "").includes(".wgsl")).map((item) => ({ name: item.name, built: item.built, cached: item.cached })),
  buildDependencies: [...stats.compilation.buildDependencies].sort(),
  fileDependencies: [...stats.compilation.fileDependencies].sort(),
};
await writeFile(input.statsPath, JSON.stringify(result, null, 2) + "\\n");
if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true, errorDetails: true }));
`;
}

function literalShader() {
  return `struct LiteralParams { color: vec4f, }
@group(0) @binding(0) var<uniform> literalParams: LiteralParams;
@compute @workgroup_size(1) fn main() { let color = literalParams.color; }
`;
}

function graphShader() {
  return `import { helper_color } from "./helper.wgsl";
@compute @workgroup_size(1) fn main() { let color = helper_color(); }
`;
}

function helperShader() {
  return "export fn helper_color() -> vec4f { return vec4f(0.1, 0.2, 0.3, 1.0); }\n";
}

function compactShader() {
  const members = Array.from({ length: 12 }, (_, index) => `m${index}: ${index % 2 === 0 ? "mat4x4f" : "array<vec4f, 4>"},`).join("\n");
  const bindings = Array.from({ length: 6 }, (_, index) => `@group(0) @binding(${index}) var<uniform> compactParams${index}: CompactParams;`).join("\n");
  return `struct CompactParams {\n${members}\n}\n${bindings}\n@compute @workgroup_size(1) fn main() { let value = compactParams0.m0; }\n`;
}

async function fixtureRoot(prefix) {
  const root = await createFixtureRoot(prefix);
  fixtureRoots.push(root);
  return root;
}
