import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { cp, mkdir, open, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  acquirePackageArchives,
  appendMutation,
  assertCandidateStd,
  assertHistoricalV1,
  assertPreparedV2,
  candidatePackageOverrides,
  createArtifactRun,
  createFixtureRoot,
  disposeFixture,
  executionCount,
  fixtureFileUrl,
  hashFile,
  hashTree,
  installExternalConsumer,
  isolatedPackageManagerUpgrade,
  mutateFileOnce,
  packageRoot,
  parseNextCacheArgs,
  replaceInstalledPackage,
  repoRoot,
  restoreOnlyCache,
  run,
  snapshotOnlyCache,
  verifyCandidateExports,
  writeCountingLoader,
  writeJson,
} from "./lib/wgsl-cache-fixture.mjs";

const options = parseNextCacheArgs(process.argv.slice(2));
const runContext = await createArtifactRun(options.artifactDir, `next-${options.next}`);
const receipt = {
  status: "running",
  node: process.version,
  requestedNextMajor: options.next,
  inputHead: null,
  artifactRun: relative(repoRoot, runContext.runDir),
  sourceRoot: repoRoot,
};
const fixtureRoots = [];

try {
  receipt.inputHead = await currentGitHead();
  const versions = installedVersions(options.next);
  receipt.versions = versions;
  const archives = await acquirePackageArchives(runContext);
  receipt.archives = archives.receipt;
  receipt.result = options.next === 16
    ? await runNext16Matrix(versions, archives)
    : await runNext15Support(versions, archives);
  receipt.status = "passed";
  receipt.finishedAt = new Date().toISOString();
  await writeJson(join(runContext.runDir, "receipt.json"), receipt);
  console.log(`WGSL Next ${options.next} cache receipt: ${join(runContext.runDir, "receipt.json")}`);
} catch (error) {
  receipt.status = "failed";
  receipt.finishedAt = new Date().toISOString();
  receipt.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
  await writeJson(join(runContext.runDir, "receipt.json"), receipt);
  throw error;
} finally {
  for (const root of fixtureRoots.reverse()) {
    await disposeFixture(root);
  }
}

async function runNext16Matrix(versions, archives) {
  assert.equal(versions.next, "16.3.3", "The full persistence matrix is pinned to Next 16.3.3.");
  const packageManagerRoot = await fixtureRoot("vgpu-next16-package-manager-");
  const packageManager = await isolatedPackageManagerUpgrade({
    root: packageManagerRoot,
    archives,
    logPath: runContext.logPath,
  });
  await disposeFixture(packageManagerRoot);
  const exportsRoot = await fixtureRoot("vgpu-next16-exports-");
  const publicExports = await verifyCandidateExports({ root: exportsRoot, archives, logPath: runContext.logPath });
  await disposeFixture(exportsRoot);

  const fixture = await createNextConsumer("vgpu-next16-cache-", versions, archives, "old");
  const oldStdSnapshot = join(fixture.root, "old-wgsl-std-snapshot");
  await cp(fixture.std.path, oldStdSnapshot, { recursive: true, dereference: true, preserveTimestamps: true });
  fixture.oldStdSnapshot = oldStdSnapshot;

  const result = {
    persistentCacheSetting: "experimental.turbopackFileSystemCacheForBuild=true",
    packageManager,
    publicExports,
  };

  result.resolvedUpgrade = await resolvedUpgradeScenario(fixture, archives);
  await removeNextScenario(fixture, "resolved-upgrade", "resolved");
  result.bareRule = await bareRuleScenario(fixture, archives);
  await removeNextScenario(fixture, "bare-rule", "bare");
  result.rawDependency = await rawDependencyScenario(fixture, archives);
  await removeNextScenario(fixture, "raw-dependency");
  result.helperFingerprint = await helperFingerprintScenario(fixture, archives);
  await removeNextScenario(fixture, "helper-fingerprint");

  await installCandidate(fixture, archives);
  await rm(fixture.oldStdSnapshot, { recursive: true, force: true });
  const watchScenario = await createDevScenario(fixture, "next16-watch");
  result.devWatch = await runDevWatch(fixture, watchScenario);
  return result;
}

async function runNext15Support(versions, archives) {
  assert.equal(versions.next, "15.5.25", "The support receipt is pinned to stable Next 15.5.25.");
  const fixture = await createNextConsumer("vgpu-next15-support-", versions, archives, "candidate");
  const supportProbe = await next15PersistenceSupportProbe(fixture);
  assert.equal(supportProbe.result, "rejected");
  assert.equal(supportProbe.name, "CanaryOnlyError");
  assert.match(supportProbe.message, /latest canary version/u);

  const scenario = await createScenario(fixture, "next15-build", "helper", false, { typescript: true });
  const built = await buildAndAssertV2(fixture, scenario, "next15-helper-build", false);
  const tsc = join(fixture.root, "node_modules/typescript/bin/tsc");
  await run(process.execPath, [tsc, "--noEmit", "-p", join(scenario.root, "tsconfig.json")], {
    cwd: scenario.root,
    logPath: runContext.logPath,
    label: "Next 15 fixture typecheck",
  });
  const watchScenario = await createDevScenario(fixture, "next15-watch");
  const devWatch = await runDevWatch(fixture, watchScenario);
  return {
    persistence: {
      supported: false,
      probe: supportProbe,
      matrix: "not run: stable Next 15.5.25 rejects the required persistence option",
    },
    build: built,
    typecheck: "passed",
    devWatch,
  };
}

async function resolvedUpgradeScenario(fixture, archives) {
  await installOld(fixture, archives);
  const scenario = await createScenario(fixture, "resolved-upgrade", "resolved", false);
  const fixedBefore = await fixedIdentities(scenario);
  const oldLoader = await resolvePublicLoader(fixture.root);
  const physicalPackageRoot = await realpath(fixture.wgsl.path);
  assert.match(oldLoader, /\/dist\/loader-webpack\/index\.js$/u);

  const cold = await buildAndAssertV1(fixture, scenario, "resolved-old-cold");
  const warm = await buildAndAssertV1(fixture, scenario, "resolved-old-warm");
  assert.equal(warm.executions, cold.executions, "Unchanged old resolved build did not reuse the persistent transform.");
  const snapshot = join(fixture.root, "cache-snapshots/resolved");
  const cacheBefore = await snapshotOnlyCache(scenario.output, snapshot);

  await installCandidate(fixture, archives);
  assert.equal(await realpath(fixture.wgsl.path), physicalPackageRoot, "Resolved upgrade moved the physical package root.");
  await restoreOnlyCache(scenario.output, snapshot);
  const candidateLoader = await resolvePublicLoader(fixture.root);
  assert.match(candidateLoader, /\/dist\/loader-webpack\/prepared\.js$/u);
  assert.notEqual(candidateLoader, oldLoader, "The public resolved loader target must change on the authentic upgrade.");
  const fixedAfter = await fixedIdentities(scenario);
  assert.deepEqual(fixedAfter, fixedBefore, "Resolved upgrade changed app/config/shader identities.");
  assert.deepEqual(await hashTree(join(scenario.output, "cache")), cacheBefore, "Restored cache bytes changed before candidate build.");

  const upgraded = await buildAndAssertV2(fixture, scenario, "resolved-candidate-upgrade", false);
  assert.ok(upgraded.executions > warm.executions, "Resolved target upgrade did not execute the candidate transform.");
  const candidateWarm = await buildAndAssertV2(fixture, scenario, "resolved-candidate-warm", false);
  assert.equal(candidateWarm.executions, upgraded.executions, "Unchanged candidate resolved build did not reuse the transform.");
  return {
    configAndShaders: fixedBefore,
    cacheBefore,
    oldLoader,
    candidateLoader,
    physicalPackageRoot,
    oldColdExecutions: cold.executions,
    oldWarmExecutions: warm.executions,
    upgradeExecutions: upgraded.executions,
    candidateWarmExecutions: candidateWarm.executions,
    result: "authentic v1 to exact v2 with retained cache and unchanged config",
  };
}

async function bareRuleScenario(fixture, archives) {
  await installOld(fixture, archives);
  const scenario = await createScenario(fixture, "bare-rule", "bare", false);
  const oldConfig = await hashFile(scenario.config);
  const physicalPackageRoot = await realpath(fixture.wgsl.path);
  const cold = await buildAndAssertV1(fixture, scenario, "bare-old-cold");
  const warm = await buildAndAssertV1(fixture, scenario, "bare-old-warm");
  assert.equal(warm.executions, cold.executions, "Unchanged old bare build did not reuse the persistent transform.");
  const snapshot = join(fixture.root, "cache-snapshots/bare");
  const cacheBefore = await snapshotOnlyCache(scenario.output, snapshot);

  await installCandidate(fixture, archives);
  assert.equal(await realpath(fixture.wgsl.path), physicalPackageRoot, "Bare upgrade moved the physical package root.");
  await restoreOnlyCache(scenario.output, snapshot);
  assert.equal(await hashFile(scenario.config), oldConfig, "Bare negative control config changed before replay.");
  const stale = await buildAndAssertV1(fixture, scenario, "bare-candidate-negative");
  assert.equal(stale.executions, warm.executions, "Bare negative control unexpectedly executed the candidate loader.");

  await restoreOnlyCache(scenario.output, snapshot);
  await writeNextConfig(fixture, scenario, "helper", false);
  const helperConfig = await hashFile(scenario.config);
  assert.notEqual(helperConfig, oldConfig, "Helper migration must change the config identity.");
  const migrated = await buildAndAssertV2(fixture, scenario, "bare-helper-migration", false);
  assert.ok(migrated.executions > stale.executions, "Helper migration did not execute the candidate transform.");
  const migratedWarm = await buildAndAssertV2(fixture, scenario, "bare-helper-warm", false);
  assert.equal(migratedWarm.executions, migrated.executions, "Unchanged helper migration build did not reuse the transform.");
  return {
    cacheBefore,
    oldConfig,
    helperConfig,
    physicalPackageRoot,
    oldColdExecutions: cold.executions,
    oldWarmExecutions: warm.executions,
    candidateBareExecutions: stale.executions,
    helperMigrationExecutions: migrated.executions,
    helperWarmExecutions: migratedWarm.executions,
    negativeControl: "stale authentic v1 retained as expected",
    migration: "public helper rebuilt exact v2 without deleting the retained cache",
  };
}

async function rawDependencyScenario(fixture, archives) {
  await installCandidate(fixture, archives);
  const scenario = await createScenario(fixture, "raw-dependency", "raw", { whitespace: true });
  const configText = await readFile(scenario.config, "utf8");
  assert.doesNotMatch(configText, /wgslTurbopackRule|vgpuImplementationFingerprint/u);
  const cold = await buildAndAssertV2(fixture, scenario, "raw-cold", { whitespace: true });
  const warm = await buildAndAssertV2(fixture, scenario, "raw-warm", { whitespace: true });
  assert.equal(warm.executions, cold.executions, "Unchanged raw-loader build did not reuse the transform.");

  const emit = join(fixture.wgsl.path, "dist/loader-shared/emit.js");
  const producerSeam = "const prepared = prepareShader({ wgsl, functionExports }, path);";
  const producerSuffix = "\n// vgpu-cache-observable-producer\n";
  const restoreProducer = await mutateFileOnce(
    emit,
    producerSeam,
    `const prepared = prepareShader({ wgsl: wgsl + ${JSON.stringify(producerSuffix)}, functionExports }, path);`,
  );
  const producerChanged = await buildAndAssertV2(
    fixture,
    scenario,
    "raw-producer-changed",
    { whitespace: true },
    { wgslSuffix: producerSuffix },
  );
  assert.ok(producerChanged.executions > warm.executions, "Raw-loader producer dependency mutation did not rebuild.");
  assert.notDeepEqual(producerChanged.artifacts, warm.artifacts, "Observable producer mutation left every prepared artifact unchanged.");
  await restoreProducer();
  const producerRestored = await buildAndAssertV2(fixture, scenario, "raw-producer-restored", { whitespace: true });
  assert.ok(producerRestored.executions > producerChanged.executions, "Restoring the raw producer did not rebuild.");
  assert.deepEqual(producerRestored.artifacts, warm.artifacts, "Restoring the producer did not restore the exact prepared artifacts.");

  const transitive = join(fixture.wgsl.path, "dist/runtime/minify.js");
  const restoreTransitive = await appendMutation(transitive, "vgpu raw transitive dependency probe");
  const transitiveChanged = await buildAndAssertV2(fixture, scenario, "raw-transitive-changed", { whitespace: true });
  assert.ok(transitiveChanged.executions > producerRestored.executions, "Raw-loader transitive dependency mutation did not rebuild.");
  await restoreTransitive();
  const transitiveRestored = await buildAndAssertV2(fixture, scenario, "raw-transitive-restored", { whitespace: true });
  assert.ok(transitiveRestored.executions > transitiveChanged.executions, "Restoring the raw transitive helper did not rebuild.");
  const finalWarm = await buildAndAssertV2(fixture, scenario, "raw-final-warm", { whitespace: true });
  assert.equal(finalWarm.executions, transitiveRestored.executions, "Final unchanged raw-loader build did not reuse the transform.");
  return {
    mechanism: "loader addDependency only; helper fingerprint absent",
    cold: cold.executions,
    warm: warm.executions,
    producerChanged: producerChanged.executions,
    producerRestored: producerRestored.executions,
    transitiveChanged: transitiveChanged.executions,
    transitiveRestored: transitiveRestored.executions,
    finalWarm: finalWarm.executions,
  };
}

async function helperFingerprintScenario(fixture, archives) {
  await installCandidate(fixture, archives);
  const loaderIndex = join(fixture.wgsl.path, "dist/loader-webpack/index.js");
  const registrationSeam = "function registerCompilerDependencies(context) {";
  await mutateFileOnce(
    loaderIndex,
    registrationSeam,
    `${registrationSeam}\n    // Fixture control: isolate pre-lookup option identity from raw dependency tracking.\n    return;`,
  );
  const noMemo = await proveNoDigestMemo(fixture.wgsl.path);
  const scenario = await createScenario(fixture, "helper-fingerprint", "helper", true);
  const cold = await buildAndAssertV2(fixture, scenario, "helper-cold", true);
  const warm = await buildAndAssertV2(fixture, scenario, "helper-warm", true);
  assert.equal(warm.executions, cold.executions, "Unchanged helper build did not reuse the transform.");

  const cases = [];
  cases.push(await helperMutation(fixture, scenario, "producer", async () => mutateFileOnce(
    join(fixture.wgsl.path, "dist/loader-shared/emit.js"),
    "const prepared = prepareShader({ wgsl, functionExports }, path);",
    "const prepared = /* vgpu helper producer fingerprint probe */ prepareShader({ wgsl, functionExports }, path);",
  )));
  cases.push(await helperMutation(fixture, scenario, "transitive-helper", () => appendMutation(
    join(fixture.wgsl.path, "dist/runtime/minify.js"),
    "vgpu helper transitive fingerprint probe",
  )));
  cases.push(await helperMutation(fixture, scenario, "inventory-helper", () => appendMutation(
    join(fixture.wgsl.path, "dist/loader-shared/compiler-inventory.js"),
    "vgpu helper inventory fingerprint probe",
  )));
  cases.push(await helperMutation(fixture, scenario, "manifest", () => mutateManifest(
    join(fixture.wgsl.path, "package.json"),
    "vgpu-cache-manifest-probe",
  )));
  cases.push(await helperMutation(fixture, scenario, "metadata-anchor", () => appendMutation(
    join(fixture.wgsl.path, "src/metadata.wgsl"),
    "vgpu helper metadata anchor fingerprint probe",
  )));
  cases.push(...await helperInventoryAddRemove(fixture, scenario));

  return {
    mechanism: "helper option identity with raw compiler dependency registration disabled in the disposable package copy",
    noGlobalDigestMemo: noMemo,
    cold: cold.executions,
    warm: warm.executions,
    cases,
  };
}

async function helperMutation(fixture, scenario, label, mutate) {
  const beforeFingerprint = await helperFingerprint(fixture.wgsl.path);
  const beforeExecutions = await executionCount(scenario.executionReceipt);
  const restore = await mutate();
  const changedFingerprint = await helperFingerprint(fixture.wgsl.path);
  assert.notEqual(changedFingerprint, beforeFingerprint, `${label} did not change helper identity.`);
  const changed = await buildAndAssertV2(fixture, scenario, `helper-${label}-changed`, true);
  assert.ok(changed.executions > beforeExecutions, `${label} identity change did not execute the transform.`);
  const warm = await buildAndAssertV2(fixture, scenario, `helper-${label}-warm`, true);
  assert.equal(warm.executions, changed.executions, `${label} unchanged warm build did not reuse the transform.`);
  await restore();
  assert.equal(await helperFingerprint(fixture.wgsl.path), beforeFingerprint, `${label} identity did not restore.`);
  return { label, beforeFingerprint, changedFingerprint, changedExecutions: changed.executions, warmExecutions: warm.executions };
}

async function helperInventoryAddRemove(fixture, scenario) {
  const baseline = await helperFingerprint(fixture.wgsl.path);
  const first = join(fixture.wgsl.path, "dist/vgpu-cache-added-probe.js");
  const second = join(fixture.wgsl.path, "dist/vgpu-cache-replacement-probe.js");
  await writeFile(first, "export const vgpuCacheAddedProbe = 1;\n");
  const addedFingerprint = await helperFingerprint(fixture.wgsl.path);
  assert.notEqual(addedFingerprint, baseline);
  const beforeAdd = await executionCount(scenario.executionReceipt);
  const added = await buildAndAssertV2(fixture, scenario, "helper-inventory-file-added", true);
  assert.ok(added.executions > beforeAdd, "Adding a published dist JS file did not execute the transform.");
  const addedWarm = await buildAndAssertV2(fixture, scenario, "helper-inventory-file-added-warm", true);
  assert.equal(addedWarm.executions, added.executions);

  await unlink(first);
  await writeFile(second, "export const vgpuCacheReplacementProbe = 2;\n");
  const replacedFingerprint = await helperFingerprint(fixture.wgsl.path);
  assert.notEqual(replacedFingerprint, addedFingerprint);
  assert.notEqual(replacedFingerprint, baseline);
  const replaced = await buildAndAssertV2(fixture, scenario, "helper-inventory-file-removed-and-replaced", true);
  assert.ok(replaced.executions > added.executions, "Removing/replacing a published dist JS file did not execute the transform.");
  const replacedWarm = await buildAndAssertV2(fixture, scenario, "helper-inventory-file-replaced-warm", true);
  assert.equal(replacedWarm.executions, replaced.executions);
  await unlink(second);
  assert.equal(await helperFingerprint(fixture.wgsl.path), baseline);
  return [
    { label: "dist-js-add", beforeFingerprint: baseline, changedFingerprint: addedFingerprint, changedExecutions: added.executions, warmExecutions: addedWarm.executions },
    { label: "dist-js-remove-and-replace", beforeFingerprint: addedFingerprint, changedFingerprint: replacedFingerprint, changedExecutions: replaced.executions, warmExecutions: replacedWarm.executions },
  ];
}

async function createNextConsumer(prefix, versions, archives, initial) {
  const root = await fixtureRoot(prefix);
  const dependencies = {
    "@vgpu/wgsl": `file:${initial === "old" ? archives.oldArchive : archives.candidateArchive}`,
    "@vgpu/wgsl-std": initial === "candidate" ? `file:${archives.candidateStdArchive}` : "0.5.0",
    next: versions.next,
    react: versions.react,
    "react-dom": versions.reactDom,
    ...(versions.typescript ? { typescript: versions.typescript } : {}),
    ...(versions.typesReact ? { "@types/react": versions.typesReact } : {}),
    ...(versions.typesReactDom ? { "@types/react-dom": versions.typesReactDom } : {}),
    ...(versions.typesNode ? { "@types/node": versions.typesNode } : {}),
  };
  const { storeDir } = await installExternalConsumer({
    root,
    packageJson: {
      private: true,
      type: "module",
      dependencies,
      ...(initial === "candidate" ? { pnpm: candidatePackageOverrides(archives) } : {}),
    },
    logPath: runContext.logPath,
  });
  await rm(storeDir, { recursive: true, force: true });
  const wgsl = await packageRoot(root, "@vgpu/wgsl");
  const std = await packageRoot(root, "@vgpu/wgsl-std");
  if (initial === "candidate") await assertCandidateStd(root, archives);
  const nextBinary = join(root, "node_modules/next/dist/bin/next");
  const fixture = { root, wgsl, std, nextBinary, versions };
  return fixture;
}

async function installOld(fixture, archives) {
  await replaceInstalledPackage(archives.oldArchive, fixture.wgsl.path, fixture.root);
  assert.ok(fixture.oldStdSnapshot, "Old WGSL std snapshot is required for authentic replay.");
  await rm(fixture.std.path, { recursive: true, force: true });
  await cp(fixture.oldStdSnapshot, fixture.std.path, { recursive: true, dereference: true, preserveTimestamps: true });
}

async function installCandidate(fixture, archives) {
  await replaceInstalledPackage(archives.candidateArchive, fixture.wgsl.path, fixture.root);
  await replaceInstalledPackage(archives.candidateStdArchive, fixture.std.path, fixture.root);
}

async function createScenario(fixture, name, mode, minify, options = {}) {
  const root = join(fixture.root, "scenarios", name);
  const app = join(root, "app");
  const output = join(root, ".next");
  const executionReceipt = join(root, "loader-executions.jsonl");
  await mkdir(app, { recursive: true });
  const countingLoader = await writeCountingLoader(root, executionReceipt);
  const extension = options.typescript ? "tsx" : "jsx";
  await Promise.all([
    writeJson(join(root, "package.json"), { private: true, type: "module" }),
    writeFile(join(app, `layout.${extension}`), options.typescript
      ? 'import type { ReactNode } from "react";\nexport default function Layout({ children }: { children: ReactNode }) { return <html><body>{children}</body></html>; }\n'
      : "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n"),
    writeFile(join(app, `page.${extension}`), pageSource()),
    writeFile(join(app, "literal.wgsl"), literalShader()),
    writeFile(join(app, "shader.wgsl"), graphShader()),
    writeFile(join(app, "helper.wgsl"), helperShader("0.1, 0.2, 0.3")),
    writeFile(join(app, "compact.wgsl"), compactShader()),
  ]);
  if (options.typescript) await writeTypeScriptFiles(root);
  const scenario = {
    root,
    app,
    output,
    executionReceipt,
    countingLoader,
    config: join(root, "next.config.mjs"),
    mode,
    minify,
  };
  await writeNextConfig(fixture, scenario, mode, minify);
  return scenario;
}

async function createDevScenario(fixture, name) {
  const root = fixture.root;
  const app = join(root, "app");
  const output = join(root, ".next");
  const executionReceipt = join(root, `${name}-loader-executions.jsonl`);
  await Promise.all([
    rm(app, { recursive: true, force: true }),
    rm(output, { recursive: true, force: true }),
  ]);
  await mkdir(app, { recursive: true });
  const countingLoader = await writeCountingLoader(root, executionReceipt);
  await Promise.all([
    writeFile(join(app, "layout.jsx"), "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n"),
    writeFile(join(app, "page.jsx"), pageSource()),
    writeFile(join(app, "literal.wgsl"), literalShader()),
    writeFile(join(app, "shader.wgsl"), graphShader()),
    writeFile(join(app, "helper.wgsl"), helperShader("0.1, 0.2, 0.3")),
    writeFile(join(app, "compact.wgsl"), compactShader()),
  ]);
  const scenario = {
    root,
    app,
    output,
    executionReceipt,
    countingLoader,
    config: join(root, "next.config.mjs"),
    mode: "helper",
    minify: false,
  };
  await writeNextConfig(fixture, scenario, "helper", false);
  return scenario;
}

async function writeNextConfig(fixture, scenario, mode, minify) {
  const persistent = fixture.versions.next.startsWith("16.")
    ? `experimental: { turbopackFileSystemCacheForBuild: true, turbopackFileSystemCacheForDev: true },`
    : "";
  const minifySource = JSON.stringify(minify);
  let imports = 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n';
  let rule;
  if (mode === "resolved" || mode === "raw") {
    rule = `{ loaders: [{ loader: ${JSON.stringify(scenario.countingLoader)}, options: {} }, { loader: require.resolve("@vgpu/wgsl/loader-webpack"), options: { minify: ${minifySource} } }], as: "*.js" }`;
  } else if (mode === "bare") {
    rule = `{ loaders: [${JSON.stringify(scenario.countingLoader)}, "@vgpu/wgsl/loader-webpack"], as: "*.js" }`;
  } else if (mode === "helper") {
    imports += 'import { wgslTurbopackRule } from "@vgpu/wgsl/next";\n';
    rule = `(() => { const rule = wgslTurbopackRule({ minify: ${minifySource} }); return { ...rule, loaders: [{ loader: ${JSON.stringify(scenario.countingLoader)}, options: {} }, ...rule.loaders] }; })()`;
  } else {
    throw new Error(`Unknown Next fixture mode: ${mode}`);
  }
  await writeFile(scenario.config, `${imports}
export default {
  ${persistent}
  turbopack: {
    root: ${JSON.stringify(fixture.root)},
    rules: { "*.wgsl": ${rule} },
  },
};
`);
  scenario.mode = mode;
  scenario.minify = minify;
}

async function buildAndAssertV1(fixture, scenario, label) {
  const actual = await nextBuild(fixture, scenario, label);
  for (const [index, artifact] of actual.entries()) assertHistoricalV1(artifact, `${label}[${index}]`);
  await writeJson(join(runContext.runDir, "artifacts", `${label}-actual.json`), actual);
  return { executions: await executionCount(scenario.executionReceipt), artifacts: actual };
}

async function buildAndAssertV2(fixture, scenario, label, minify, oracleOptions = {}) {
  const actual = await nextBuild(fixture, scenario, label);
  const expected = await oracleArtifacts(fixture, scenario, minify, oracleOptions);
  await Promise.all([
    writeJson(join(runContext.runDir, "artifacts", `${label}-actual.json`), actual),
    writeJson(join(runContext.runDir, "artifacts", `${label}-expected.json`), expected),
  ]);
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assertPreparedV2(actual[index], expected[index], `${label}[${index}]`);
  }
  return { executions: await executionCount(scenario.executionReceipt), artifacts: actual };
}

async function nextBuild(fixture, scenario, label) {
  await run(process.execPath, [fixture.nextBinary, "build", scenario.root, "--turbopack"], {
    cwd: fixture.root,
    logPath: runContext.logPath,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
    label,
  });
  const html = await readFile(join(scenario.output, "server/app/index.html"), "utf8");
  const match = html.match(/<pre id="artifacts">([^<]+)<\/pre>/u);
  assert.ok(match, `Could not find serialized WGSL artifacts in ${label} output.`);
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

async function oracleArtifacts(fixture, scenario, minify, options = {}) {
  const specs = [
    { path: join(scenario.app, "literal.wgsl"), graph: false },
    { path: join(scenario.app, "shader.wgsl"), graph: true },
    { path: join(scenario.app, "compact.wgsl"), graph: false },
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
    label: "independent prepared-v2 oracle",
  });
  return JSON.parse(result.stdout.trim());
}

async function fixedIdentities(scenario) {
  return {
    config: await hashFile(scenario.config),
    app: await hashTree(scenario.app),
    root: scenario.root,
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

async function removeNextScenario(fixture, name, snapshot) {
  await rm(join(fixture.root, "scenarios", name), { recursive: true, force: true });
  if (snapshot !== undefined) {
    await rm(join(fixture.root, "cache-snapshots", snapshot), { recursive: true, force: true });
  }
}

async function resolvePublicLoader(consumerRoot) {
  const code = 'const { createRequire } = require("node:module"); console.log(createRequire(process.cwd() + "/package.json").resolve("@vgpu/wgsl/loader-webpack"));';
  const result = await run(process.execPath, ["--eval", code], {
    cwd: consumerRoot,
    logPath: runContext.logPath,
    quiet: true,
    label: "resolve public loader",
  });
  return result.stdout.trim();
}

async function helperFingerprint(wgslRoot) {
  const code = `
import { wgslTurbopackRule } from ${JSON.stringify(fixtureFileUrl(join(wgslRoot, "dist/next/index.js")))};
console.log(wgslTurbopackRule().loaders[0].options.vgpuImplementationFingerprint);
`;
  const result = await run(process.execPath, ["--input-type=module", "--eval", code], {
    cwd: dirname(wgslRoot),
    logPath: runContext.logPath,
    quiet: true,
    label: "read helper fingerprint",
  });
  const fingerprint = result.stdout.trim();
  assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/u);
  return fingerprint;
}

async function proveNoDigestMemo(wgslRoot) {
  const module = await import(fixtureFileUrl(join(wgslRoot, "dist/next/index.js")));
  const probe = join(wgslRoot, "dist/vgpu-cache-no-memo-probe.js");
  const before = module.wgslTurbopackRule().loaders[0].options.vgpuImplementationFingerprint;
  await writeFile(probe, "export const vgpuCacheNoMemoProbe = true;\n");
  const changed = module.wgslTurbopackRule().loaders[0].options.vgpuImplementationFingerprint;
  await unlink(probe);
  const restored = module.wgslTurbopackRule().loaders[0].options.vgpuImplementationFingerprint;
  assert.notEqual(changed, before);
  assert.equal(restored, before);
  return { before, changed, restored };
}

async function mutateManifest(path, marker) {
  const original = await readFile(path);
  const manifest = JSON.parse(original.toString("utf8"));
  assert.equal(Object.hasOwn(manifest, "vgpuCacheFixtureMarker"), false);
  manifest.vgpuCacheFixtureMarker = marker;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return async () => writeFile(path, original);
}

async function next15PersistenceSupportProbe(fixture) {
  const code = `
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const { default: loadConfig } = require("next/dist/server/config.js");
const { PHASE_PRODUCTION_BUILD } = require("next/constants");
try {
  await loadConfig(PHASE_PRODUCTION_BUILD, process.cwd(), { customConfig: { experimental: { turbopackPersistentCaching: true } }, silent: true });
  console.log(JSON.stringify({ node: process.version, next: require("next/package.json").version, result: "accepted" }));
} catch (error) {
  console.log(JSON.stringify({ node: process.version, next: require("next/package.json").version, result: "rejected", name: error.constructor.name, message: error.message }));
}
`;
  const result = await run(process.execPath, ["--input-type=module", "--eval", code], {
    cwd: fixture.root,
    logPath: runContext.logPath,
    quiet: true,
    label: "Next 15 persistent-cache support probe",
  });
  const probe = JSON.parse(result.stdout.trim());
  await writeJson(join(runContext.runDir, "next15-cache-support.json"), probe);
  return probe;
}

async function runDevWatch(fixture, scenario) {
  assert.equal(scenario.root, fixture.root, "Dev watch fixture must use the top-level isolated consumer root.");
  await assert.rejects(
    () => realpath(join(fixture.root, ".pnpm-store")),
    (error) => error?.code === "ENOENT",
    "The private pnpm store must not be inside the Turbopack watch root.",
  );
  const limit = await run("/bin/sh", ["-c", "ulimit -n"], {
    cwd: scenario.root,
    logPath: runContext.logPath,
    quiet: true,
    label: "record dev open-file limit",
  });
  const openFileLimit = limit.stdout.trim();
  assert.match(openFileLimit, /^(?:\d+|unlimited)$/u);
  const logPath = join(runContext.runDir, `${fixture.versions.next.startsWith("15.") ? "next15" : "next16"}-dev.log`);
  const log = await open(logPath, "a");
  const port = await availablePort();
  const child = spawn(process.execPath, [fixture.nextBinary, "dev", "--turbopack", "-p", String(port)], {
    cwd: scenario.root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", log.fd, log.fd],
  });
  const helper = join(scenario.app, "helper.wgsl");
  const original = await readFile(helper);
  try {
    const initial = await pollPage(port, (response, body) => response.ok && body.includes("0.1, 0.2, 0.3"), "initial dev shader");
    await writeFile(helper, helperShader("0.9, 0.8, 0.7"));
    const edited = await pollPage(port, (response, body) => response.ok && body.includes("0.9, 0.8, 0.7"), "edited imported shader");
    await unlink(helper);
    const deleted = await pollPage(port, (response, body) => !response.ok || /Module not found|VGPU-WGSL-RES-NOTFOUND/u.test(body), "deleted import error");
    await writeFile(helper, helperShader("0.6, 0.5, 0.4"));
    const recreated = await pollPage(port, (response, body) => response.ok && body.includes("0.6, 0.5, 0.4"), "recreated imported shader");
    return {
      projectRoot: scenario.root,
      turbopackRoot: fixture.root,
      privateStore: "external temporary directory removed before dev",
      openFileLimit,
      port,
      initial,
      edited,
      deleted,
      recreated,
      log: relative(runContext.runDir, logPath),
    };
  } finally {
    await writeFile(helper, original);
    await stopChild(child);
    await log.close();
  }
}

async function pollPage(port, accept, label) {
  const deadline = Date.now() + 90_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) });
      const body = await response.text();
      last = `${response.status}: ${body.slice(0, 300)}`;
      if (accept(response, body)) return { status: response.status, observedAt: new Date().toISOString() };
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for ${label}; last response: ${last}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  const timeout = new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000, "timeout"));
  if (await Promise.race([exited, timeout]) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

async function writeTypeScriptFiles(root) {
  await Promise.all([
    writeFile(join(root, "next-env.d.ts"), '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n'),
    writeFile(join(root, "wgsl-env.d.ts"), '/// <reference types="@vgpu/wgsl/wgsl-types" />\n'),
    writeJson(join(root, "tsconfig.json"), {
      compilerOptions: {
        target: "ES2022",
        lib: ["dom", "dom.iterable", "es2022"],
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "preserve",
        incremental: true,
        plugins: [{ name: "next" }],
      },
      include: ["next-env.d.ts", "wgsl-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    }),
  ]);
}

function installedVersions(major) {
  const packagePath = major === 16 ? join(repoRoot, "apps/docs/package.json") : join(repoRoot, "examples/next-wgsl/package.json");
  const require = createRequire(packagePath);
  const rootRequire = createRequire(join(repoRoot, "package.json"));
  return {
    next: require("next/package.json").version,
    react: require("react/package.json").version,
    reactDom: require("react-dom/package.json").version,
    typescript: major === 15 ? rootRequire("typescript/package.json").version : undefined,
    typesReact: major === 15 ? require("@types/react/package.json").version : undefined,
    typesReactDom: major === 15 ? require("@types/react-dom/package.json").version : undefined,
    typesNode: major === 15 ? rootRequire("@types/node/package.json").version : undefined,
  };
}

function pageSource() {
  return `import literal from "./literal.wgsl";
import graph from "./shader.wgsl";
import compact from "./compact.wgsl";
export default function Page() {
  const encoded = Buffer.from(JSON.stringify([literal, graph, compact])).toString("base64");
  return <main><pre id="artifacts">{encoded}</pre><pre id="graph-wgsl">{graph.wgsl}</pre></main>;
}
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

function helperShader(color) {
  return `export fn helper_color() -> vec4f { return vec4f(${color}, 1.0); }\n`;
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
