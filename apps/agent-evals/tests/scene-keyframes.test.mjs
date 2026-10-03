import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SCENE_TASK_IDS,
  sceneContract,
  sceneContractRevision,
  sceneFixturePaths,
} from "../evals/lib/scene-contracts.mjs";
import {
  collectSceneRunProvenance,
  sceneTemplateObservation,
  collectSkillLoadCalls,
  sceneKeyframeAdvertisementFields,
  sceneEvalDefinitions,
} from "../evals/lib/scene-eval.ts";
import { readTaskVgpuSkill } from "../agent/skills/vgpu.ts";
import {
  analyzeSceneKeyframeDependencies,
  initialMathAbsenceErrors,
} from "../agent/lib/scene-keyframe-dependencies.ts";
import { observeSceneKeyframeSkillAdvertisement } from "../agent/hooks/finalize-turn.ts";
import {
  gradeSceneKeyframes,
  keyframeFixtureMetrics,
  keyframeMarkerCenters,
  keyframeWorldAt,
  sceneKeyframesInputSha256,
  sceneKeyframesContract,
} from "../evals/lib/scene-keyframes.mjs";

test("the quaternion oracle reproduces the contract identity example", () => {
  const contract = sceneKeyframesContract(1);
  assert.deepEqual(contract.exampleInput, {
    version: 1,
    requestId: "scene-quaternion-keyframes-example",
    keyframes: [
      { time: 0, rotation: [0, 0, 0, 1] },
      { time: 1, rotation: [0, 0, 0, 1] },
    ],
    frames: [{ time: 0 }],
  });
  assert.deepEqual(keyframeWorldAt(contract.exampleInput.keyframes, 0), [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
});

test("the quaternion oracle follows the closed form, ignores stored sign, and clamps", () => {
  const { input } = sceneKeyframesContract(2);
  for (const frame of input.frames) {
    const actual = keyframeWorldAt(input.keyframes, frame.time);
    const expected = closedFormWorld(input.keyframes, frame.time);
    assertVectorClose(actual, expected, 1e-12);
  }

  const signFlipped = input.keyframes.map((keyframe, index) => ({
    ...keyframe,
    rotation: index % 2 === 0 ? keyframe.rotation.map((value) => -value) : [...keyframe.rotation],
  }));
  for (const frame of input.frames) {
    assertVectorClose(
      keyframeWorldAt(signFlipped, frame.time),
      keyframeWorldAt(input.keyframes, frame.time),
      1e-12,
    );
  }

  assertVectorClose(
    keyframeWorldAt(input.keyframes, -100),
    keyframeWorldAt(input.keyframes, input.keyframes[0].time),
    1e-12,
  );
  assertVectorClose(
    keyframeWorldAt(input.keyframes, 100),
    keyframeWorldAt(input.keyframes, input.keyframes.at(-1).time),
    1e-12,
  );
});

test("the frozen fixtures satisfy the geometric and hash invariants", () => {
  const expectedHashes = [
    "c24f904af6507ed6328da3e907ae1b88167b4588e9262c299722c7e329832dff",
    "8793962f513a4960bae89bbca21d225131c510eb3fefc432fd0f7ec6ac8d2244",
  ];
  for (const stage of [1, 2]) {
    const { input } = sceneKeyframesContract(stage);
    const metrics = keyframeFixtureMetrics(input);
    assert.equal(sceneKeyframesInputSha256(input), expectedHashes[stage - 1]);
    assert.ok(metrics.maximumUnitError <= 1e-12, JSON.stringify(metrics));
    assert.ok(metrics.maximumSegmentAngleDegrees <= 170, JSON.stringify(metrics));
    assert.ok(metrics.minimumProjectedSeparation >= Math.sqrt(3) * 0.4 * 64 + 8,
      JSON.stringify(metrics));
    assert.ok(metrics.minimumEdgeDistance >= 40, JSON.stringify(metrics));
  }
});

test("the keyframe grader accepts an independent synthetic rendering", async () => {
  const { input, width, height } = sceneKeyframesContract(2);
  const { result, images } = syntheticSubmission(input, width, height);
  const grade = await gradeSceneKeyframes({
    input,
    result,
    width,
    height,
    readPng: async (path) => images.get(path),
  });
  assert.equal(grade.outcome, "pass", JSON.stringify(grade, null, 2));
  assert.deepEqual(grade.checks.map((check) => [check.name, check.ok]), [
    ["protocol", true],
    ["artifacts", true],
    ["state", true],
    ["pixels", true],
  ]);
});

test("the keyframe grader rejects protocol and pixel faults at their intended gates", async () => {
  const { input, width, height } = sceneKeyframesContract(2);
  const clean = syntheticSubmission(input, width, height);
  for (const [name, mutate, expectedCheck] of [
    ["five-pixel shift", () => syntheticSubmission(input, width, height, { shift: [5, 0] }), "pixels"],
    ["swapped colors", () => syntheticSubmission(input, width, height, { swap: true }), "pixels"],
    ["wrong frame count", () => ({ ...clean, result: { ...clean.result, frames: clean.result.frames.slice(1) } }), "protocol"],
    ["NaN state", () => {
      const result = structuredClone(clean.result);
      result.frames[0].state.world[0] = NaN;
      return { ...clean, result };
    }, "protocol"],
    ["absolute path", () => {
      const result = structuredClone(clean.result);
      result.frames[0].color = "/tmp/frame.png";
      return { ...clean, result };
    }, "protocol"],
  ]) {
    const submission = mutate();
    const grade = await gradeSceneKeyframes({
      input,
      result: submission.result,
      width,
      height,
      readPng: async (path) => submission.images.get(path),
    });
    assert.equal(grade.outcome, "application-failure", name);
    assert.equal(grade.checks.find((check) => check.name === expectedCheck)?.ok, false, name);
  }
});

test("the seed is minimal and gives requirements without a package or API recipe", () => {
  const root = new URL("../agent/sandbox/tasks/scene-quaternion-keyframes/", import.meta.url);
  assert.deepEqual(readdirSync(root).sort(), ["contract.md", "example-input.json", "package.json"]);
  assert.deepEqual(JSON.parse(readFileSync(new URL("package.json", root), "utf8")), {
    private: true,
    type: "module",
  });
  assert.deepEqual(JSON.parse(readFileSync(new URL("example-input.json", root), "utf8")),
    sceneKeyframesContract(1).exampleInput);
  const visible = [
    readFileSync(new URL("contract.md", root), "utf8"),
    readFileSync(new URL("example-input.json", root), "utf8"),
    sceneKeyframesContract(1).prompt,
    sceneKeyframesContract(2).prompt,
  ].join("\n");
  for (const forbidden of [
    /slerp/i,
    /nlerp/i,
    /\blerp\b/i,
    /\bmath\b/i,
    /pmndrs/i,
    /wgpu-matrix/i,
    /\bthree\b/i,
    /glmatrix/i,
  ]) assert.doesNotMatch(visible, forbidden);
  assert.equal(readFileSync(new URL("../agent/instructions.md", import.meta.url), "utf8"),
    readFileSync(join(process.cwd(), "apps/agent-evals/agent/instructions.md"), "utf8"));
});

test("the task is dispatched without changing any old contract, seed, or experiment arm", () => {
  const frozen = JSON.parse(readFileSync(
    new URL("fixtures/scene-neutral-v1.json", import.meta.url),
    "utf8",
  ));
  for (const expected of frozen.contracts) {
    assert.equal(
      sha256(JSON.stringify(sceneContract(expected.taskId, expected.stage))),
      expected.sha256,
      `${expected.taskId} stage ${expected.stage}`,
    );
  }
  for (const expected of frozen.seedFiles) {
    assert.equal(sha256(readFileSync(join(process.cwd(), expected.path))), expected.sha256, expected.path);
  }

  assert.equal(SCENE_TASK_IDS.includes("scene-quaternion-keyframes"), true);
  assert.deepEqual(sceneContract("scene-quaternion-keyframes", 1), sceneKeyframesContract(1));
  assert.deepEqual(sceneContract("scene-quaternion-keyframes", 2), sceneKeyframesContract(2));
  assert.equal(sceneContractRevision("scene-quaternion-keyframes"), "scene-quaternion-keyframes-v1");
  assert.deepEqual(sceneFixturePaths("scene-quaternion-keyframes"), []);
  assert.doesNotThrow(() => sceneEvalDefinitions("scene-quaternion-keyframes", "keyframes", {}));
  assert.throws(
    () => sceneEvalDefinitions("scene-quaternion-keyframes", "keyframes", {
      VGPU_EVALS_SCENE_GUIDANCE: "math",
    }),
    /does not participate.*guidance/i,
  );

  const rejected = spawnSync(process.execPath, [
    "scripts/agent-evals.mjs",
    "--task",
    "scene-quaternion-keyframes",
    "--skip-pack",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { PATH: process.env.PATH, VGPU_EVALS_SCENE_GUIDANCE: "math" },
    timeout: 10_000,
  });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /scene-quaternion-keyframes does not participate in the scene guidance experiment/);
  assert.doesNotMatch(rejected.stderr, /OIDC|tarball|pack/i);
});

test("the public skill bytes resolve only for the quaternion task", () => {
  const skillPath = join(process.cwd(), "skills/vgpu/SKILL.md");
  const markdown = readFileSync(skillPath, "utf8");
  const expectedSha256 = sha256(markdown);
  for (const taskId of [
    "scene-robot-arm",
    "scene-math-interop",
    "scene-shader-bindings",
    "s2-gradient",
  ]) {
    assert.equal(readTaskVgpuSkill(taskId, { skillPath, expectedSha256 }), null, taskId);
  }
  const resolved = readTaskVgpuSkill("scene-quaternion-keyframes", {
    skillPath,
    expectedSha256,
  });
  assert.equal(resolved.markdown, markdown);
  assert.equal(resolved.sha256, expectedSha256);
  assert.match(resolved.description, /vgpu/i);
  const sceneMarkdown = readFileSync(join(process.cwd(), "skills/vgpu/scene.md"), "utf8");
  assert.deepEqual(resolved.files, { "scene.md": sceneMarkdown });
  assert.equal(resolved.sceneSha256, sha256(sceneMarkdown));
  assert.throws(() => readTaskVgpuSkill("scene-quaternion-keyframes", {
    skillPath, expectedSha256, expectedSceneSha256: "stale",
  }), /scene skill hash mismatch/);
  assert.doesNotThrow(() => readTaskVgpuSkill("scene-quaternion-keyframes", {
    skillPath, expectedSha256, expectedSceneSha256: sha256(sceneMarkdown),
  }));
});

test("skill advertisement rejects missing or changed scene references", async () => {
  const root = "/home/eve/.agents/skills/vgpu";
  const markdown = "# vgpu\n";
  const scene = "# Scenes\n";
  for (const value of [null, "stale", scene]) {
    const files = { [`${root}/SKILL.md`]: markdown };
    if (value !== null) files[`${root}/scene.md`] = value;
    const result = await observeSceneKeyframeSkillAdvertisement(
      advertisementSandbox(files), sha256(markdown), sha256(scene),
    );
    assert.equal(result.advertised, value === scene);
    assert.equal(result.integrity, value === scene ? "pass" : "infrastructure-error");
    assert.equal(result.sceneReference.path, `${root}/scene.md`);
    assert.equal(result.sceneReference.matches, value === scene);
    assert.deepEqual(sceneKeyframeAdvertisementFields(result).sceneReference, result.sceneReference);
  }
});

test("initial dependency provenance rejects direct, locked, installed, and transitive math", () => {
  const clean = {
    packageJsonText: '{"private":true,"dependencies":{"vgpu":"file:vgpu.tgz"}}',
    packageLockText: JSON.stringify({ packages: {
      "": { dependencies: { vgpu: "file:vgpu.tgz" } },
      "node_modules/wgpu-matrix": { version: "3.4.0" },
    } }),
    mathPackageText: null,
    wgpuMatrixPackageText: '{"name":"wgpu-matrix","version":"3.4.0"}',
    threePackageText: null,
    dependencyTreeText: '{"name":"fixture","dependencies":{"vgpu":{"version":"0.5.0"}}}',
  };
  const cleanSnapshot = analyzeSceneKeyframeDependencies(clean);
  assert.deepEqual(initialMathAbsenceErrors(cleanSnapshot), []);
  assert.equal(cleanSnapshot.packages.math.present, false);
  assert.equal(cleanSnapshot.packages.wgpuMatrix.version, "3.4.0");
  assert.equal(cleanSnapshot.packages.three.present, false);

  const cases = [
    { ...clean, mathPackageText: '{"name":"math","version":"0.1.0"}' },
    { ...clean, packageLockText: JSON.stringify({ packages: { "node_modules/math": { version: "0.1.0" } } }) },
    { ...clean, packageJsonText: '{"dependencies":{"math":"0.1.0"}}' },
    { ...clean, dependencyTreeText: '{"dependencies":{"vgpu":{"dependencies":{"math":{"version":"0.1.0"}}}}}' },
  ];
  for (const sources of cases) {
    const snapshot = analyzeSceneKeyframeDependencies(sources);
    assert.notDeepEqual(initialMathAbsenceErrors(snapshot), []);
  }

  for (const sources of [
    { ...clean, packageJsonText: null },
    { ...clean, packageJsonText: "{" },
    { ...clean, packageLockText: null },
    { ...clean, packageLockText: "[]" },
    { ...clean, dependencyTreeText: null },
    { ...clean, dependencyTreeText: "not json" },
  ]) {
    const snapshot = analyzeSceneKeyframeDependencies(sources);
    assert.notDeepEqual(initialMathAbsenceErrors(snapshot), [], JSON.stringify(sources));
  }
});

test("skill load provenance requires the completed frozen markdown bytes", () => {
  const advertisedMarkdown = "---\ndescription: test\n---\n# vgpu\n";
  const loadedBody = "# vgpu\n";
  const frozenBodySha256 = sha256(loadedBody);
  const calls = collectSkillLoadCalls([
    { name: "load_skill", input: { skill: "vgpu" }, output: undefined, status: "completed", turnIndex: 0 },
    { name: "load_skill", input: { skill: "vgpu" }, output: loadedBody, status: "failed", turnIndex: 0 },
    { name: "load_skill", input: { skill: "other" }, output: loadedBody, status: "completed", turnIndex: 0 },
    { name: "load_skill", input: { skill: "vgpu" }, output: "stale", status: "completed", turnIndex: 0 },
    { name: "load_skill", input: { skill: "vgpu" }, output: advertisedMarkdown, status: "completed", turnIndex: 0 },
    { name: "load_skill", input: { skill: "vgpu" }, output: loadedBody, status: "completed", turnIndex: 0 },
  ], frozenBodySha256);
  assert.deepEqual(calls.map((call) => call.successful), [false, false, false, false, false, true]);
  assert.equal(calls[0].outputSha256, null);
  assert.equal(calls[5].observedLoadedBodySha256, frozenBodySha256);
  assert.equal(calls[5].matchesExpectedLoadedBodySha256, true);
});

test("skill advertisement provenance requires exact materialized bytes outside the workspace", async () => {
  const markdown = "---\ndescription: test\n---\n# vgpu\n";
  const expectedFullMarkdownSha256 = sha256(markdown);
  const skillPath = "/home/eve/.agents/skills/vgpu/SKILL.md";
  const fallbackPath = "/workspace/skills/vgpu/SKILL.md";

  const exact = await observeSceneKeyframeSkillAdvertisement(
    advertisementSandbox({ [skillPath]: markdown }),
    expectedFullMarkdownSha256,
  );
  assert.equal(exact.advertised, true);
  assert.equal(exact.materializedPath, skillPath);
  assert.equal(exact.materializedPresent, true);
  assert.equal(exact.materializedSha256, expectedFullMarkdownSha256);
  assert.equal(exact.materializedOutsideWorkspace, true);
  assert.equal(exact.integrity, "pass");
  assert.equal(exact.error, null);
  const exactFields = sceneKeyframeAdvertisementFields(exact);
  assert.equal(exactFields.advertisementError, null);
  assert.equal(exactFields.advertisedFullMarkdownSha256, expectedFullMarkdownSha256);

  const absentFields = sceneKeyframeAdvertisementFields(null);
  assert.equal(absentFields.advertised, false);
  assert.equal(absentFields.advertisementIntegrity, "infrastructure-error");
  assert.equal(absentFields.advertisementError, "advertisement was not observed");

  const absent = await observeSceneKeyframeSkillAdvertisement(
    advertisementSandbox({}),
    expectedFullMarkdownSha256,
  );
  assert.equal(absent.advertised, false);
  assert.equal(absent.materializedPath, null);
  assert.equal(absent.materializedPresent, false);
  assert.equal(absent.materializedSha256, null);
  assert.equal(absent.integrity, "infrastructure-error");

  const mutated = await observeSceneKeyframeSkillAdvertisement(
    advertisementSandbox({ [skillPath]: `${markdown} ` }),
    expectedFullMarkdownSha256,
  );
  assert.equal(mutated.advertised, false);
  assert.equal(mutated.materializedPresent, true);
  assert.notEqual(mutated.materializedSha256, expectedFullMarkdownSha256);
  assert.match(mutated.error, /hash mismatch/);

  const fallback = await observeSceneKeyframeSkillAdvertisement(
    advertisementSandbox({ [fallbackPath]: markdown }, { home: "" }),
    expectedFullMarkdownSha256,
  );
  assert.equal(fallback.advertised, false);
  assert.equal(fallback.materializedPath, fallbackPath);
  assert.equal(fallback.materializedPresent, true);
  assert.equal(fallback.materializedSha256, expectedFullMarkdownSha256);
  assert.equal(fallback.materializedOutsideWorkspace, false);
  assert.match(fallback.error, /inside \/workspace/);
});

test("run provenance identifies the dirty harness independently from the packed package git", () => {
  const provenance = collectSceneRunProvenance({
    VGPU_EVALS_REPO_ROOT: process.cwd(),
    VGPU_EVALS_VGPU_SKILL_SHA256: "a".repeat(64),
    VGPU_EVALS_VGPU_SKILL_BODY_SHA256: "c".repeat(64),
    VGPU_EVALS_VGPU_SKILL_GENERATOR_SHA256: "b".repeat(64),
  }, join(process.cwd(), "apps/agent-evals/.work/tarballs"), "scene-quaternion-keyframes");
  assert.equal(typeof provenance.skillDelivery.harnessAggregateSha256, "string");
  assert.ok(provenance.skillDelivery.harnessFiles.length >= 8);
  assert.ok(provenance.skillDelivery.harnessFiles.every((entry) =>
    typeof entry.path === "string" && /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.equal(typeof provenance.skillDelivery.workspaceGitHead, "string");
  assert.ok([true, false, "unavailable"].includes(provenance.skillDelivery.workspaceDirty));
});

test("native keyframe controls cover both turns with four independent positives and disclosed faults", async () => {
  const { controlCases } = await import("../scripts/scene-controls.mjs");
  const cases = controlCases("scene-quaternion-keyframes");
  assert.deepEqual(cases.filter((control) => control.positive).map((control) => control.fault), [
    "handwritten",
    "math",
    "wgpu-matrix",
    "sphere",
  ]);
  assert.ok(cases.every((control) => JSON.stringify(control.stages) === "[1,2]"));
  assert.deepEqual(cases.find((control) => control.fault === "long-arc").stageExpectations, {
    1: { expectPass: true, rejectChecks: [] },
    2: { rejectChecks: ["state", "pixels"], expectedRejectingFrames: [4, 5, 6, 8, 9] },
  });
  assert.deepEqual(cases.find((control) => control.fault === "no-clamp").stageExpectations, {
    1: { expectPass: true, rejectChecks: [] },
    2: { rejectChecks: ["state", "pixels"], expectedRejectingFrames: [1, 11] },
  });
  assert.deepEqual(cases.filter((control) => control.requirePassingChecks).map((control) => control.fault), [
    "stale-publish",
    "frame0-png-reuse",
    "swap-red-green",
  ]);
});

function syntheticSubmission(input, width, height, { shift = [0, 0], swap = false } = {}) {
  const images = new Map();
  const frames = input.frames.map((frame, index) => {
    const world = keyframeWorldAt(input.keyframes, frame.time);
    const centers = keyframeMarkerCenters(world, width, height)
      .map(([x, y]) => [x + shift[0], y + shift[1]]);
    const path = `${String(index).padStart(3, "0")}-color.png`;
    images.set(path, rasterizeDiscs(width, height, centers, swap));
    return { index, color: path, state: { world } };
  });
  return { result: { version: 1, requestId: input.requestId, frames }, images };
}

function advertisementSandbox(files, { home = "/home/eve" } = {}) {
  return {
    async run() {
      return { exitCode: 0, stdout: `${home}\n`, stderr: "" };
    },
    async readTextFile({ path }) {
      return files[path] ?? null;
    },
  };
}

function rasterizeDiscs(width, height, centers, swap) {
  const data = Buffer.alloc(width * height * 4);
  const colors = swap
    ? [[0, 255, 0, 255], [255, 0, 0, 255], [0, 0, 255, 255]]
    : [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset + 3] = 255;
      const marker = centers.findIndex(([centerX, centerY]) =>
        Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY) <= 13);
      if (marker !== -1) data.set(colors[marker], offset);
    }
  }
  return { width, height, data };
}

function closedFormWorld(keyframes, time) {
  const clamped = Math.max(keyframes[0].time, Math.min(keyframes.at(-1).time, time));
  let index = keyframes.findIndex((entry, candidate) =>
    candidate < keyframes.length - 1 && clamped <= keyframes[candidate + 1].time);
  if (index === -1) index = keyframes.length - 2;
  const a = keyframes[index].rotation;
  let b = keyframes[index + 1].rotation;
  if (dot4(a, b) < 0) b = b.map((value) => -value);
  const u = (clamped - keyframes[index].time) /
    (keyframes[index + 1].time - keyframes[index].time);
  const inverseA = [-a[0], -a[1], -a[2], a[3]];
  const delta = multiplyQuaternion(inverseA, b);
  const halfAngle = Math.atan2(Math.hypot(delta[0], delta[1], delta[2]), delta[3]);
  const axisLength = Math.hypot(delta[0], delta[1], delta[2]);
  const axis = axisLength < 1e-15
    ? [0, 0, 0]
    : delta.slice(0, 3).map((value) => value / axisLength);
  const step = [
    axis[0] * Math.sin(u * halfAngle),
    axis[1] * Math.sin(u * halfAngle),
    axis[2] * Math.sin(u * halfAngle),
    Math.cos(u * halfAngle),
  ];
  return matrixFromQuaternion(multiplyQuaternion(a, step));
}

function multiplyQuaternion(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function matrixFromQuaternion([x, y, z, w]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0,
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0,
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
}

function dot4(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function assertVectorClose(actual, expected, tolerance) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= tolerance,
      `index ${index}: expected ${expected[index]}, received ${value}`);
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("cold-template bootstrap evidence is observed after creation and rejects stale seed receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "keyframe-cold-bootstrap-"));
  const taskId = "scene-quaternion-keyframes";
  const tarballDirectory = join(root, "tarballs");
  const env = { VGPU_EVALS_WORK_DIR: root, VGPU_EVALS_TASK_SEED_KEY: "seed" };
  try {
    mkdirSync(tarballDirectory);
    mkdirSync(join(root, "template-provenance"));
    writeFileSync(join(tarballDirectory, "tarballs.json"), JSON.stringify({ sourceKey: "source" }));
    assert.equal(sceneTemplateObservation(taskId, env, tarballDirectory).initialDependencySnapshot, null);
    const initialDependencySnapshot = { sentinel: "recorded during bootstrap before agent installation" };
    const receipt = { templateKey: `vgpu-source-default-corpus-${taskId}-seed`, initialDependencySnapshot };
    writeFileSync(join(root, "template-provenance", `${taskId}.json`), JSON.stringify(receipt));
    assert.deepEqual(sceneTemplateObservation(taskId, env, tarballDirectory).initialDependencySnapshot,
      initialDependencySnapshot);
    assert.equal(sceneTemplateObservation(taskId, { ...env, VGPU_EVALS_TASK_SEED_KEY: "other" },
      tarballDirectory).initialDependencySnapshot, null);
    assert.equal("initialDependencySnapshot" in sceneTemplateObservation("scene-math-interop", env,
      tarballDirectory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
