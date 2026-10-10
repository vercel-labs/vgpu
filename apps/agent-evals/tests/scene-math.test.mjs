import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWarehouseFrames,
  containsConvexPoint,
  multiply4,
  orthographic,
  projectPoint,
  robotJoints,
  rotationZ,
  translation,
} from "../evals/lib/scene-math.mjs";
import { sceneContract } from "../evals/lib/scene-contracts.mjs";

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test("robot joints compose parent transforms and reset absolutely", () => {
  const rest = robotJoints({
    basePosition: [-1.8, -0.7, 0],
    baseAngle: 0,
    shoulderAngle: 0,
    elbowAngle: 0,
    wristAngle: 0,
  });
  assert.deepEqual(rest.tip.slice(12, 15), [1.3, -0.35, 0]);

  const pose = robotJoints({
    basePosition: [2, 3, 0],
    baseAngle: Math.PI / 2,
    shoulderAngle: 0,
    elbowAngle: 0,
    wristAngle: 0,
  });
  close(pose.elbow[12], 1.65);
  close(pose.elbow[13], 4.5);
  close(pose.tip[12], 1.65);
  close(pose.tip[13], 6.1);

  assert.deepEqual(robotJoints(sceneContract("scene-robot-arm", 2).input.frames.at(-1)), rest);
});

test("matrix multiplication is column-major and noncommutative", () => {
  const translatedThenRotated = multiply4(translation([3, 4, 0]), rotationZ(Math.PI / 2));
  const rotatedThenTranslated = multiply4(rotationZ(Math.PI / 2), translation([3, 4, 0]));
  assert.deepEqual(translatedThenRotated.slice(12, 15), [3, 4, 0]);
  close(rotatedThenTranslated[12], -4);
  close(rotatedThenTranslated[13], 3);
});

test("orthographic projection uses WebGPU depth and camera shift signs", () => {
  const projection = orthographic({ left: -4, right: 4, bottom: -3, top: 3, near: 0.1, far: 20 });
  close(projection[10], 1 / (0.1 - 20));
  close(projection[14], 0.1 / (0.1 - 20));
  const initial = projectPoint([0, 0, 0], { width: 512, height: 384, cameraPosition: [0, 0, 8], bounds: [-4, 4, -3, 3, 0.1, 20] });
  const moved = projectPoint([0, 0, 0], { width: 512, height: 384, cameraPosition: [0.8, 0.45, 8], bounds: [-4, 4, -3, 3, 0.1, 20] });
  close(moved[0] - initial[0], -51.2);
  close(moved[1] - initial[1], 28.8);
});

test("convex rotated masks exclude AABB corners and edge bands", () => {
  const diamond = [[5, 1], [9, 5], [5, 9], [1, 5]];
  assert.equal(containsConvexPoint(diamond, [5.5, 5.5], 0), true);
  assert.equal(containsConvexPoint(diamond, [1.5, 1.5], 0), false);
  assert.equal(containsConvexPoint(diamond, [5, 1.5], 1), false);
  assert.equal(containsConvexPoint(diamond, [5, 5], 1), true);
});

test("warehouse operations independently delete, move, recolor, and preserve stable IDs", () => {
  const contract = sceneContract("scene-warehouse", 2);
  const states = applyWarehouseFrames(contract.input.items, contract.input.frames);
  assert.equal(states[0].count, 2304);
  assert.equal(states[1].count, 2303);
  assert.equal(states[1].items.some((item) => item.appId === 10290), false);
  assert.deepEqual(states[2].items.find((item) => item.appId === 49152).position, [-6.5, 23.5, 0]);
  assert.deepEqual(states[2].items.find((item) => item.appId === 49152).tint, [0, 1, 1, 1]);
  assert.equal(states[3].count, 2302);
  assert.equal(states[3].items.some((item) => item.appId === 26950), false);
  assert.deepEqual(states[3].items.find((item) => item.appId === 49135).position, [13.5, 3.5, 0]);
  assert.deepEqual(states[3].items.find((item) => item.appId === 49135).tint, [0, 0, 1, 1]);
});
