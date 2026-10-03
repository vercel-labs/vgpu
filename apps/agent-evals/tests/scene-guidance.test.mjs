import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DOCS_MANIFEST_TAR_PATH,
  compareSceneGuidanceCorpora,
  normalizedPackageLockSha256,
  parseSceneExperimentEnv,
  prepareSceneGuidanceFixture,
  readTarEntry,
  sceneExperimentInstallSpecs,
  validateSceneExperimentRuntime,
  validatePreparedSceneGuidanceVariant,
} from "../scripts/scene-guidance.mjs";
import { tarballsFingerprint } from "../scripts/tarballs-fingerprint.mjs";
import { sceneEvalDefinitions } from "../evals/lib/scene-eval.ts";
import { observeSceneGuidanceInstall } from "../agent/lib/scene-guidance.ts";

const BASE_RECORDS = [
  {
    package: "vgpu",
    symbol: "scene-composition",
    repoPath: "docs/topics/scene-composition.docs.md",
    kind: "guide",
    virtualPath: "/guides/scene-composition.docs.md",
    anchor: "scene-composition",
    content: "# Scene composition\n\nOriginal guidance.\n",
  },
  {
    package: "vgpu",
    symbol: "unchanged",
    repoPath: "docs/topics/unchanged.docs.md",
    kind: "guide",
    virtualPath: "/guides/unchanged.docs.md",
    anchor: "unchanged",
    content: "# Unchanged\n",
  },
];

const MATH_RECORD = {
  package: "vgpu",
  symbol: "scene-math",
  repoPath: "docs/topics/scene-math.docs.md",
  kind: "guide",
  virtualPath: "/guides/scene-math.docs.md",
  anchor: "scene-math",
  content: "# Using math with scene data\n\nChecked against math@0.1.0.\n",
};

function docsSource(records) {
  return `export const docsManifest = ${JSON.stringify({
    schemaVersion: 3,
    generatedFrom: "docs/allowlist.txt + docs/topics + docs/migrations",
    records,
  }, null, 2)};\n`;
}

function currentDocsSource() {
  return docsSource([
    { ...BASE_RECORDS[0], content: "# Scene composition\n\nOriginal guidance.\n\nSee scene-math.docs.md.\n" },
    BASE_RECORDS[1],
    MATH_RECORD,
  ]);
}

function makeTarball(sourceDirectory, tarballPath) {
  const result = spawnSync("tar", ["-czf", tarballPath, "-C", sourceDirectory, "package"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

function makeSourceTarballs(root, docs = currentDocsSource()) {
  const source = join(root, "source-tarballs");
  const tree = join(root, "current-tree", "package");
  mkdirSync(join(tree, "dist", "cli", "lib", "generated"), { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "vgpu", version: "0.5.0" }));
  writeFileSync(join(tree, "runtime.js"), "export const runtime = true;\n");
  writeFileSync(join(tree, ...DOCS_MANIFEST_TAR_PATH.split("/").slice(1)), docs);
  makeTarball(join(root, "current-tree"), join(source, "vgpu-0.5.0.tgz"));
  writeFileSync(join(source, "vgpu-core-0.5.0.tgz"), "unchanged dependency tarball");
  writeFileSync(join(source, "tarballs.json"), `${JSON.stringify({
    packedAt: "2026-09-29T00:00:00.000Z",
    sourceKey: "source-key",
    gitSha: "runtime-sha-after-tooling",
    gitBranch: "test-branch",
    rootPackage: "vgpu",
    tarballs: [
      { name: "@vgpu/core", version: "0.5.0", file: "vgpu-core-0.5.0.tgz" },
      { name: "vgpu", version: "0.5.0", file: "vgpu-0.5.0.tgz" },
    ],
  }, null, 2)}\n`);
  return source;
}

test("scene guidance and repetitions are opt-in and reject ambiguous values", () => {
  assert.deepEqual(parseSceneExperimentEnv({}), { variant: null, repetitions: 1 });
  assert.deepEqual(parseSceneExperimentEnv({ VGPU_EVALS_SCENE_GUIDANCE: "baseline" }), {
    variant: "baseline",
    repetitions: 1,
  });
  assert.deepEqual(parseSceneExperimentEnv({
    VGPU_EVALS_SCENE_GUIDANCE: "math",
    VGPU_EVALS_SCENE_REPETITIONS: "2",
  }), { variant: "math", repetitions: 2 });

  for (const env of [
    { VGPU_EVALS_SCENE_GUIDANCE: "current" },
    { VGPU_EVALS_SCENE_GUIDANCE: "BASELINE" },
    { VGPU_EVALS_SCENE_REPETITIONS: "0" },
    { VGPU_EVALS_SCENE_REPETITIONS: "3" },
    { VGPU_EVALS_SCENE_REPETITIONS: "1.5" },
  ]) assert.throws(() => parseSceneExperimentEnv(env), /VGPU_EVALS_SCENE_/);
});

test("experiment mode pins the model and sandbox image without changing default runs", () => {
  assert.doesNotThrow(() => validateSceneExperimentRuntime({ variant: null }, {}));
  const pinned = {
    VGPU_EVALS_MODEL: "anthropic/claude-sonnet-5",
    VGPU_EVALS_DOCKER_IMAGE:
      "ghcr.io/vercel/eve@sha256:de79f9a495add7cd1691e3496afc1c3227b0846f9ae0b26126f120c91af3445c",
  };
  assert.doesNotThrow(() => validateSceneExperimentRuntime({ variant: "baseline" }, pinned));
  assert.throws(() => validateSceneExperimentRuntime({ variant: "math" }, {}), /VGPU_EVALS_MODEL/);
  assert.throws(
    () => validateSceneExperimentRuntime({ variant: "math" }, { ...pinned, VGPU_EVALS_DOCKER_IMAGE: "ghcr.io/vercel/eve:latest" }),
    /VGPU_EVALS_DOCKER_IMAGE/,
  );
});

test("normalized lock provenance ignores only vgpu archive identity", () => {
  const first = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { math: "0.1.0", vgpu: "file:.vgpu-tarballs/vgpu-0.5.0.tgz" } },
      "node_modules/math": { version: "0.1.0", integrity: "math-integrity" },
      "node_modules/vgpu": { version: "0.5.0", resolved: "file:first", integrity: "first-integrity" },
    },
  });
  const second = first.replace("file:first", "file:second").replace("first-integrity", "second-integrity");
  assert.equal(normalizedPackageLockSha256(first), normalizedPackageLockSha256(second));
  assert.notEqual(normalizedPackageLockSha256(first), normalizedPackageLockSha256(first.replace("math-integrity", "changed")));
});

test("scene eval definitions preserve the old singleton and fan out repetitions into fresh cases", () => {
  const singleton = sceneEvalDefinitions("scene-robot-arm", "robot", {});
  assert.equal(Array.isArray(singleton), false);
  const repeated = sceneEvalDefinitions("scene-robot-arm", "robot", {
    VGPU_EVALS_SCENE_REPETITIONS: "2",
  });
  assert.equal(Array.isArray(repeated), true);
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0], repeated[1]);
});

test("corpus comparison permits only the scene math record and scene composition content", () => {
  const comparison = compareSceneGuidanceCorpora(docsSource(BASE_RECORDS), currentDocsSource());
  assert.deepEqual(comparison.added, ["/guides/scene-math.docs.md#scene-math"]);
  assert.deepEqual(comparison.changed, ["/guides/scene-composition.docs.md#scene-composition"]);
  assert.deepEqual(comparison.removed, []);

  const unrelatedEdit = structuredClone(BASE_RECORDS);
  unrelatedEdit[1].content = "tampered";
  assert.throws(
    () => compareSceneGuidanceCorpora(docsSource(BASE_RECORDS), docsSource([
      { ...BASE_RECORDS[0], content: "changed" },
      unrelatedEdit[1],
      MATH_RECORD,
    ])),
    /unexpected docs corpus change/i,
  );
  assert.throws(
    () => compareSceneGuidanceCorpora(docsSource(BASE_RECORDS), docsSource([
      { ...BASE_RECORDS[0], summary: "metadata changed", content: "changed" },
      BASE_RECORDS[1],
      MATH_RECORD,
    ])),
    /content-only/i,
  );
  assert.throws(
    () => compareSceneGuidanceCorpora(docsSource(BASE_RECORDS), docsSource(BASE_RECORDS)),
    /scene-math/i,
  );
});

test("prepared variants isolate corpus bytes, retain dependencies, and reject tampering", () => {
  const root = mkdtempSync(join(tmpdir(), "scene-guidance-test-"));
  const sourceTarballs = makeSourceTarballs(root);
  const prepared = prepareSceneGuidanceFixture({
    sourceTarballsDir: sourceTarballs,
    outputRoot: join(root, "prepared"),
    baselineDocsSource: docsSource(BASE_RECORDS),
    currentDocsSource: currentDocsSource(),
    baselineGitSha: "baseline-sha",
    currentGitSha: "current-sha",
  });
  assert.equal(prepared.manifest.runtimeGitSha, "runtime-sha-after-tooling");
  assert.equal(prepared.manifest.currentDocsGitSha, "current-sha");

  const baseline = validatePreparedSceneGuidanceVariant(prepared.variants.baseline.tarballsDir, "baseline");
  const math = validatePreparedSceneGuidanceVariant(prepared.variants.math.tarballsDir, "math");
  assert.equal(baseline.sceneGuidance.dependency.name, "math");
  assert.equal(baseline.sceneGuidance.dependency.version, "0.1.0");
  assert.deepEqual(baseline.tarballs.map(({ name, version, file }) => ({ name, version, file })),
    math.tarballs.map(({ name, version, file }) => ({ name, version, file })));
  const baselineFingerprint = tarballsFingerprint(prepared.variants.baseline.tarballsDir);
  assert.notEqual(baselineFingerprint, tarballsFingerprint(prepared.variants.math.tarballsDir));
  const repackedBaseline = join(root, "baseline-repack");
  cpSync(prepared.variants.baseline.tarballsDir, repackedBaseline, { recursive: true });
  const repackedManifestPath = join(repackedBaseline, "tarballs.json");
  const repackedManifest = JSON.parse(readFileSync(repackedManifestPath, "utf8"));
  writeFileSync(repackedManifestPath, `${JSON.stringify({ ...repackedManifest, packedAt: "later" }, null, 2)}\n`);
  assert.equal(tarballsFingerprint(repackedBaseline), baselineFingerprint);
  const baselineCore = baseline.tarballs.find((entry) => entry.name === "@vgpu/core");
  const mathCore = math.tarballs.find((entry) => entry.name === "@vgpu/core");
  assert.equal(baselineCore.sha256, mathCore.sha256);

  const baselineTar = join(prepared.variants.baseline.tarballsDir, "vgpu-0.5.0.tgz");
  const mathTar = join(prepared.variants.math.tarballsDir, "vgpu-0.5.0.tgz");
  assert.equal(readTarEntry(baselineTar, DOCS_MANIFEST_TAR_PATH).toString("utf8"), docsSource(BASE_RECORDS));
  assert.equal(readTarEntry(mathTar, DOCS_MANIFEST_TAR_PATH).toString("utf8"), currentDocsSource());
  assert.equal(readTarEntry(baselineTar, "package/runtime.js").toString("utf8"), "export const runtime = true;\n");
  assert.doesNotMatch(readTarEntry(baselineTar, DOCS_MANIFEST_TAR_PATH).toString("utf8"), /math@0\.1\.0/);

  writeFileSync(join(prepared.variants.baseline.tarballsDir, "vgpu-core-0.5.0.tgz"), "tampered");
  assert.throws(
    () => validatePreparedSceneGuidanceVariant(prepared.variants.baseline.tarballsDir, "baseline"),
    /sha256|tamper/i,
  );
  rmSync(root, { recursive: true, force: true });
});

test("the actual frozen manifests prepare successfully with repeated virtual paths", () => {
  const show = (revision) => {
    const result = spawnSync("git", ["show", `${revision}:packages/vgpu/lib/generated/docs-manifest.generated.js`], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const baselineDocsSource = show("a8a9bc8a");
  const currentDocsSource = show("929b97f5");
  const root = mkdtempSync(join(tmpdir(), "scene-guidance-real-corpus-"));
  const prepared = prepareSceneGuidanceFixture({
    sourceTarballsDir: makeSourceTarballs(root, currentDocsSource),
    outputRoot: join(root, "prepared"),
    baselineDocsSource,
    currentDocsSource,
    baselineGitSha: "a8a9bc8a",
    currentGitSha: "929b97f5",
  });
  assert.deepEqual(prepared.manifest.comparison, {
    added: ["/guides/scene-math.docs.md#scene-math"],
    removed: [],
    changed: ["/guides/scene-composition.docs.md#scene-composition"],
  });
  rmSync(root, { recursive: true, force: true });
});

test("math is added only by experiment bootstrap and default scene seeds stay unchanged", () => {
  assert.deepEqual(sceneExperimentInstallSpecs({}), []);
  assert.deepEqual(sceneExperimentInstallSpecs({ sceneGuidance: {} }), ["math@0.1.0"]);
  for (const task of ["scene-robot-arm", "scene-shader-bindings", "scene-warehouse"]) {
    const pkg = JSON.parse(readFileSync(join(
      process.cwd(),
      "apps/agent-evals/agent/sandbox/tasks",
      task,
      "package.json",
    ), "utf8"));
    assert.equal(pkg.dependencies?.math, undefined);
  }
});

test("per-turn observation records assigned corpus and retains mismatches as deviations", async () => {
  const root = mkdtempSync(join(tmpdir(), "scene-guidance-observation-"));
  const previous = process.env.VGPU_EVALS_TARBALLS_DIR;
  const docs = Buffer.from("assigned docs");
  const docsSha256 = createHash("sha256").update(docs).digest("hex");
  writeFileSync(join(root, "tarballs.json"), JSON.stringify({
    tarballs: [{ name: "vgpu", version: "0.5.0" }],
    sceneGuidance: {
      variant: "math",
      docsSha256,
      dependency: { name: "math", version: "0.1.0" },
    },
  }));
  process.env.VGPU_EVALS_TARBALLS_DIR = root;
  let mathVersion = "0.1.0";
  const sandbox = {
    async run() {
      return { exitCode: 0, stdout: "node_modules/vgpu/dist/cli/lib/generated/docs-manifest.generated.js\n", stderr: "" };
    },
    async readBinaryFile() { return docs; },
    async readTextFile({ path }) {
      return JSON.stringify({ version: path.includes("/math/") ? mathVersion : "0.5.0" });
    },
  };
  try {
    const clean = await observeSceneGuidanceInstall(sandbox);
    assert.equal(clean.protocolDeviation, false);
    assert.equal(clean.observed.docsSha256, docsSha256);
    mathVersion = "9.9.9";
    const changed = await observeSceneGuidanceInstall(sandbox);
    assert.equal(changed.protocolDeviation, true);
    assert.equal(changed.observed.mathVersion, "9.9.9");
  } finally {
    if (previous === undefined) delete process.env.VGPU_EVALS_TARBALLS_DIR;
    else process.env.VGPU_EVALS_TARBALLS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
