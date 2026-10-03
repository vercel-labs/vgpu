import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createWorld } from "../agent/sandbox/tasks/scene-math-interop/ecs/world.mjs";
import {
  SCENE_TASK_IDS,
  sceneContract,
  sceneContractRevision,
  sceneFixturePaths,
} from "../evals/lib/scene-contracts.mjs";
import {
  applySceneInteropInput,
  assertSceneInteropFixture,
  gradeSceneInterop,
  renderSceneInteropOracleFrame,
  sceneInteropExample,
} from "../evals/lib/scene-interop.mjs";
import { sceneEvalDefinitions } from "../evals/lib/scene-eval.ts";

const ROOT = process.cwd();
const FROZEN = JSON.parse(readFileSync(join(ROOT, "apps/agent-evals/tests/fixtures/scene-neutral-v1.json"), "utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("launcher rejects guidance arms for explicit interop before authentication or model calls", () => {
  for (const variant of ["baseline", "math"]) {
    const result = spawnSync(process.execPath, [
      "scripts/agent-evals.mjs", "--task", "scene-math-interop", "--skip-pack",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH, VGPU_EVALS_SCENE_GUIDANCE: variant },
      timeout: 10_000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /scene-math-interop does not participate in the scene guidance experiment/);
  }
});

test("interop has an isolated revision while neutral contracts and seeds stay frozen", () => {
  assert.equal(SCENE_TASK_IDS.includes("scene-math-interop"), true);

  for (const expected of FROZEN.contracts) {
    assert.equal(
      sha256(JSON.stringify(sceneContract(expected.taskId, expected.stage))),
      expected.sha256,
      `${expected.taskId} stage ${expected.stage}`,
    );
  }
  for (const expected of FROZEN.seedFiles) {
    assert.equal(sha256(readFileSync(join(ROOT, expected.path))), expected.sha256, expected.path);
  }

  const first = sceneContract("scene-math-interop", 1);
  const second = sceneContract("scene-math-interop", 2);
  assert.equal(first.revision, "scene-math-interop-v1");
  assert.equal(second.revision, "scene-math-interop-v1");
  assert.equal(first.width, 512);
  assert.equal(first.height, 384);
  assert.equal(first.input.entities.length, 9);
  assert.equal(first.input.frames.length, 4);
  assert.equal(second.input.entities.length, 9);
  assert.equal(second.input.frames.length, 4);
  assert.equal(first.input.frames.every((frame) => !Object.hasOwn(frame, "index")), true);
  assert.deepEqual(first.input.frames[0], { commands: [] });
  assert.deepEqual(second.input.frames[1].commands.map((command) => command.op), [
    "spawn",
    "parent",
    "set",
    "despawn",
  ]);
  assert.match(first.prompt, /leave ecs\/ unchanged/i);
  assert.match(second.prompt, /keys are never reused/i);
  assert.match(first.prompt, /installed math@0\.1\.0/i);
  assert.match(first.prompt, /camera projection and inversion/i);
  assert.match(first.prompt, /mesh-matrix composition/i);
  assert.match(first.prompt, /instances from vgpu\/scene and instanceGeometry from vgpu\/scene\/gpu/);
  assert.match(first.prompt, /\/guides\/scene-math\.docs\.md/i);
  assert.equal(sceneContractRevision("scene-robot-arm"), "scene-evals-v1");
  assert.equal(sceneContractRevision("scene-math-interop"), "scene-math-interop-v1");
  assert.deepEqual(sceneFixturePaths("scene-math-interop"), ["ecs/README.md", "ecs/world.mjs"]);
  assert.deepEqual(sceneFixturePaths("scene-shader-bindings"), ["integration.wgsl"]);
  assert.deepEqual(sceneFixturePaths("scene-warehouse"), []);
  assert.throws(
    () => sceneEvalDefinitions("scene-math-interop", "interop", { VGPU_EVALS_SCENE_GUIDANCE: "math" }),
    /does not participate in.*guidance/i,
  );
});

test("fixture invariants and independent state/pixel gates reject isolated faults", async () => {
  for (const stage of [1, 2]) {
    const contract = sceneContract("scene-math-interop", stage);
    const oracle = applySceneInteropInput(contract.input);
    assert.equal(assertSceneInteropFixture(oracle, contract.width, contract.height), true);
    const images = new Map();
    const result = {
      version: 1,
      requestId: contract.input.requestId,
      frames: oracle.map((frame, index) => {
        const color = `${String(index).padStart(3, "0")}-color.png`;
        images.set(color, renderSceneInteropOracleFrame(frame, contract.width, contract.height));
        return { index, color, state: frame.state };
      }),
    };
    const positive = await gradeSceneInterop({ ...contract, result, readPng: (path) => images.get(path) });
    assert.equal(positive.outcome, "pass");
    assert.equal(positive.checks.find((check) => check.name === "artifacts").ok, true);

    const staleState = structuredClone(result);
    staleState.frames[1].state.entities[1].world[12] += 0.25;
    const stateGrade = await gradeSceneInterop({ ...contract, result: staleState, readPng: (path) => images.get(path) });
    assert.equal(stateGrade.checks.find((check) => check.name === "interop-state").ok, false);
    assert.equal(stateGrade.checks.find((check) => check.name === "interop-pixels").ok, true);

    const stalePixels = structuredClone(result);
    stalePixels.frames[1].color = stalePixels.frames[0].color;
    const pixelGrade = await gradeSceneInterop({ ...contract, result: stalePixels, readPng: (path) => images.get(path) });
    assert.equal(pixelGrade.checks.find((check) => check.name === "interop-state").ok, true);
    assert.equal(pixelGrade.checks.find((check) => check.name === "interop-pixels").ok, false);
    assert.equal((await gradeSceneInterop({ ...contract, result, fixturesUnmodified: false, readPng: (path) => images.get(path) })).checks.find((check) => check.name === "ecs-unmodified").ok, false);
  }
});

test("invalid oracle fixtures are infrastructure failures", async () => {
  const contract = sceneContract("scene-math-interop", 1);
  const broken = structuredClone(contract.input);
  broken.entities[1].position = [100, 100, 0];
  const oracle = applySceneInteropInput(broken);
  const result = {
    version: 1,
    requestId: broken.requestId,
    frames: oracle.map((frame, index) => ({ index, color: `${index}.png`, state: frame.state })),
  };
  const grade = await gradeSceneInterop({
    ...contract,
    input: broken,
    result,
    readPng: () => ({ width: contract.width, height: contract.height, data: new Uint8Array(contract.width * contract.height * 4) }),
  });
  assert.equal(grade.outcome, "infrastructure-error");
  assert.equal(grade.checks.find((check) => check.name === "verifier").ok, false);
});

test("essential native controls have bounded stages and checked restore-frame expectations", async () => {
  const { controlCases } = await import("../scripts/scene-controls.mjs");
  const cases = controlCases("scene-math-interop");
  assert.deepEqual(cases.filter((entry) => entry.fault === "positive").length, 1);
  assert.equal(cases.find((entry) => entry.fault === "turn1-only").stage, 2);
  assert.deepEqual(cases.find((entry) => entry.fault === "missed-publish").expectedRejectingFrames, [2, 3]);
  assert.equal(cases.find((entry) => entry.fault === "missed-publish").expectedRejectingFrames.includes(4), false);
  for (const fault of [
    "reverse-order", "double-parent", "shear-loss", "ortho-no", "stale-camera",
    "descendant-update-omission", "missed-publish", "key-as-row", "orphan-instances",
    "camera-local", "cached-count", "turn1-only",
  ]) assert.ok(cases.some((entry) => entry.fault === fault), fault);
});

test("seed ECS owns stable matrices, propagates parents, and reuses rows generationally", () => {
  const world = createWorld({ capacity: 4 });
  const localMatrices = world.localMatrices;
  const worldMatrices = world.worldMatrices;
  const root = world.spawn({
    parent: null,
    position: [1, 2, 0],
    rotation: [0, 0, 0, 1],
    scale: [2, 1, 1],
    renderable: { size: [7, 8, 9], offset: [4, 5, 6], color: [255, 0, 0] },
  });
  const child = world.spawn({
    parent: root,
    position: [1, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  });

  assert.deepEqual(world.update(), [0, 1]);
  assert.equal(world.localMatrices, localMatrices);
  assert.equal(world.worldMatrices, worldMatrices);
  assert.deepEqual(Array.from(world.worldMatrices.subarray(0, 16)), [
    2, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    1, 2, 0, 1,
  ]);
  assert.deepEqual(Array.from(world.worldMatrices.subarray(16, 32)), [
    2, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    3, 2, 0, 1,
  ]);
  assert.deepEqual(world.renderable(root), {
    size: [7, 8, 9],
    offset: [4, 5, 6],
    color: [255, 0, 0],
  });

  const versions = Array.from(world.worldVersion);
  world.setPosition(root, [2, 2, 0]);
  assert.deepEqual(world.update(), [0, 1]);
  assert.equal(world.worldMatrices[12], 2);
  assert.equal(world.worldMatrices[28], 4);
  assert.equal(world.worldVersion[0], versions[0] + 1);
  assert.equal(world.worldVersion[1], versions[1] + 1);

  world.despawn(root);
  assert.deepEqual(world.entities(), []);
  assert.equal(world.isAlive(root), false);
  assert.equal(world.isAlive(child), false);
  const replacement = world.spawn({
    parent: null,
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  });
  assert.equal(world.rowOf(replacement), 0);
  assert.notEqual(replacement, root);
  assert.throws(() => world.rowOf(root), /stale|live/i);
});

test("independent oracle reproduces the contract example and the seeded ECS", () => {
  const example = sceneInteropExample();
  const exampleFrames = applySceneInteropInput(example.input);
  assert.deepEqual(
    exampleFrames.map(({ state }, index) => ({ index, color: `${String(index).padStart(3, "0")}-color.png`, state })),
    example.output.frames,
  );

  for (const stage of [1, 2]) {
    const { input } = sceneContract("scene-math-interop", stage);
    const oracleFrames = applySceneInteropInput(input);
    const world = createWorld({ capacity: 64 });
    const handles = [];
    const spawnedRows = new Map();
    for (const entity of input.entities) {
      handles.push(world.spawn({
        ...entity,
        parent: entity.parent == null ? null : handles[entity.parent],
      }));
    }
    for (let frameIndex = 0; frameIndex < input.frames.length; frameIndex += 1) {
      for (const command of input.frames[frameIndex].commands) {
        if (command.op === "set") {
          if (command.position) world.setPosition(handles[command.key], command.position);
          if (command.rotation) world.setRotation(handles[command.key], command.rotation);
          if (command.scale) world.setScale(handles[command.key], command.scale);
        } else if (command.op === "spawn") {
          const handle = world.spawn({
            ...command,
            parent: command.parent == null ? null : handles[command.parent],
          });
          handles.push(handle);
          spawnedRows.set(handles.length - 1, world.rowOf(handle));
        } else if (command.op === "parent") {
          world.setParent(handles[command.key], command.parent == null ? null : handles[command.parent]);
        } else if (command.op === "despawn") {
          world.despawn(handles[command.key]);
        }
      }
      world.update();
      const observed = handles.flatMap((handle, key) => world.isAlive(handle)
        ? [{ key, world: Array.from(world.worldMatrices.subarray(world.rowOf(handle) * 16, world.rowOf(handle) * 16 + 16)) }]
        : []);
      assertMatricesClose(observed, oracleFrames[frameIndex].state.entities, `stage ${stage} frame ${frameIndex}`);
      assertMatricesClose(
        [{ key: 0, world: oracleFrames[frameIndex].state.viewProjection }],
        [{ key: 0, world: oracleFrames[frameIndex].state.viewProjection }],
        "view projection is finite",
      );
    }
    if (stage === 2) {
      assert.equal(spawnedRows.get(10), 3);
      assert.equal(spawnedRows.get(11), 1);
    }
  }
});

function assertMatricesClose(actual, expected, label) {
  assert.deepEqual(actual.map((entry) => entry.key), expected.map((entry) => entry.key), label);
  actual.forEach((entry, entityIndex) => entry.world.forEach((value, index) => {
    assert.ok(Number.isFinite(value), `${label}: finite matrix value`);
    assert.ok(Math.abs(value - expected[entityIndex].world[index]) < 1e-5, `${label}: key ${entry.key} matrix[${index}]`);
  }));
}
