import assert from "node:assert/strict";
import test from "node:test";
import { sceneContract } from "../evals/lib/scene-contracts.mjs";
import { gradeSceneOutput } from "../evals/lib/grade-scene.mjs";
import {
  applyWarehouseFrames,
  containsConvexPoint,
  matrixWithBox,
  projectedRectangle,
  robotJoints,
  viewProjection,
} from "../evals/lib/scene-math.mjs";

const ROBOT_PARTS = [
  ["base", [0, 0, 0], [0.6, 0.5, 0.3], [255, 255, 0, 255], 0.15],
  ["shoulder", [0.75, 0, 0], [1.5, 0.22, 0.25], [255, 0, 0, 255], 0.125],
  ["elbow", [0.55, 0, 0], [1.1, 0.18, 0.2], [0, 255, 0, 255], 0.1],
  ["wrist", [0.25, 0, 0], [0.5, 0.24, 0.2], [0, 0, 255, 255], 0.1],
  ["tip", [0, 0, 0.2], [0.12, 0.12, 0.12], [255, 0, 255, 255], 0.26],
];

function png(width, height, color = [0, 0, 0, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { width, height, data };
}

function setPixel(image, x, y, color) {
  image.data.set(color, (y * image.width + x) * 4);
}

function robotArtifacts(contract) {
  const images = new Map();
  const frames = contract.input.frames.map((input, index) => {
    const joints = robotJoints(input);
    const image = png(contract.width, contract.height);
    const shapes = ROBOT_PARTS.map(([joint, center, dimensions, color, depth]) => ({
      color,
      depth,
      polygon: projectedRectangle(matrixWithBox(joints[joint], center, dimensions), {
        width: contract.width,
        height: contract.height,
        cameraPosition: [0, 0, 8],
        bounds: [-4, 4, -3, 3, 0.1, 20],
      }),
    }));
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const hit = shapes.filter((shape) => containsConvexPoint(shape.polygon, [x + 0.5, y + 0.5])).sort((a, b) => b.depth - a.depth)[0];
        if (hit) setPixel(image, x, y, hit.color);
      }
    }
    const color = `${index}-color.png`;
    images.set(color, image);
    return { index, color, state: { joints } };
  });
  return { result: { version: 1, requestId: contract.input.requestId, frames }, readPng: (path) => images.get(path), images };
}

function shaderArtifacts(contract) {
  const origins = { left: [-1.5, -0.6, 0], right: [1.3, -0.4, 0], upper: [-0.1, 1, 0] };
  const tints = { left: [223, 32, 32, 255], right: [32, 223, 32, 255], upper: [32, 32, 223, 255] };
  const images = new Map();
  const frames = contract.input.frames.map((input, index) => {
    const image = png(contract.width, contract.height);
    for (const [name, origin] of Object.entries(origins)) {
      const centerX = contract.width * ((origin[0] - input.cameraPosition[0]) / 8 + 0.5);
      const centerY = contract.height * (0.5 - (origin[1] - input.cameraPosition[1]) / 6);
      for (let y = Math.ceil(centerY - 19.2); y < centerY + 19.2; y += 1) {
        for (let x = Math.ceil(centerX - 19.2); x < centerX + 19.2; x += 1) setPixel(image, x, y, tints[name]);
      }
    }
    const color = `${index}-color.png`;
    images.set(color, image);
    return {
      index,
      color,
      state: { viewProjection: viewProjection(input.cameraPosition, [-4, 4, -3, 3, 0.1, 20]), origins },
    };
  });
  return { result: { version: 1, requestId: contract.input.requestId, frames }, readPng: (path) => images.get(path), images };
}

function warehouseArtifacts(contract) {
  const states = applyWarehouseFrames(contract.input.items, contract.input.frames);
  const images = new Map();
  const frames = states.map((state, index) => {
    const colorImage = png(contract.width, contract.height);
    const idImage = png(contract.width, contract.height);
    for (const item of state.items) {
      const centerX = (item.position[0] + 24) * 12;
      const centerY = (24 - item.position[1]) * 12;
      const color = item.tint.map((value, channel) => channel === 3 ? 255 : value * 255);
      const id = [item.appId & 255, (item.appId >> 8) & 255, (item.appId >> 16) & 255, 255];
      for (let y = Math.ceil(centerY - 3.6); y < centerY + 3.6; y += 1) {
        for (let x = Math.ceil(centerX - 3.6); x < centerX + 3.6; x += 1) {
          setPixel(colorImage, x, y, color);
          setPixel(idImage, x, y, id);
        }
      }
    }
    const color = `${index}-color.png`;
    const ids = `${index}-ids.png`;
    images.set(color, colorImage);
    images.set(ids, idImage);
    return { index, color, ids, state };
  });
  return { result: { version: 1, requestId: contract.input.requestId, frames }, readPng: (path) => images.get(path), images };
}

test("robot analytic images and matrices pass; reversed hierarchy, stale image, and malformed state fail independently", async () => {
  const contract = sceneContract("scene-robot-arm", 2);
  const artifacts = robotArtifacts(contract);
  const positive = await gradeSceneOutput({ ...contract, ...artifacts });
  assert.equal(positive.outcome, "pass");
  assert.equal(positive.checks.find((check) => check.name === "robot-pixels").metrics.pixelRatio, 1);

  const wrongMatrix = structuredClone(artifacts.result);
  wrongMatrix.frames[2].state.joints.tip[12] += 0.1;
  assert.equal((await gradeSceneOutput({ ...contract, result: wrongMatrix, readPng: artifacts.readPng })).checks.find((check) => check.name === "robot-matrices").ok, false);

  const stale = structuredClone(artifacts.result);
  stale.frames[3].color = stale.frames[0].color;
  const staleGrade = await gradeSceneOutput({ ...contract, result: stale, readPng: artifacts.readPng });
  assert.equal(staleGrade.checks.find((check) => check.name === "robot-matrices").ok, true);
  assert.equal(staleGrade.checks.find((check) => check.name === "robot-pixels").ok, false);

  const malformed = structuredClone(artifacts.result);
  malformed.frames[0].state.joints.base = [Number.NaN];
  assert.equal((await gradeSceneOutput({ ...contract, result: malformed, readPng: artifacts.readPng })).outcome, "application-failure");
});

test("robot pixels gate every part and tip on every frame instead of pooling small local errors", async () => {
  const contract = sceneContract("scene-robot-arm", 2);
  const artifacts = robotArtifacts(contract);
  const colorPath = artifacts.result.frames[0].color;

  const oneBadTipPixel = structuredClone(artifacts.images.get(colorPath));
  oneBadTipPixel.data = new Uint8Array(oneBadTipPixel.data);
  const tipPixels = findPixels(oneBadTipPixel, [255, 0, 255, 255]);
  const tipOffset = tipPixels[Math.floor(tipPixels.length / 2)];
  oneBadTipPixel.data.set([0, 0, 0, 255], tipOffset);
  const tipGrade = await gradeSceneOutput({
    ...contract,
    result: artifacts.result,
    readPng: (path) => path === colorPath ? oneBadTipPixel : artifacts.readPng(path),
  });
  const tipCheck = tipGrade.checks.find((check) => check.name === "robot-pixels");
  assert.equal(tipCheck.ok, false);
  assert.deepEqual(tipCheck.metrics.failingFrames, [1]);

  const fourBadWristPixels = structuredClone(artifacts.images.get(colorPath));
  fourBadWristPixels.data = new Uint8Array(fourBadWristPixels.data);
  const wristPixels = findPixels(fourBadWristPixels, [0, 0, 255, 255]);
  const wristMiddle = Math.floor(wristPixels.length / 2);
  for (const offset of wristPixels.slice(wristMiddle - 8, wristMiddle + 8)) {
    fourBadWristPixels.data.set([0, 0, 0, 255], offset);
  }
  const wristGrade = await gradeSceneOutput({
    ...contract,
    result: artifacts.result,
    readPng: (path) => path === colorPath ? fourBadWristPixels : artifacts.readPng(path),
  });
  const wristCheck = wristGrade.checks.find((check) => check.name === "robot-pixels");
  assert.equal(wristCheck.ok, false);
  assert.ok(wristCheck.metrics.parts.some((part) => part.frame === 1 && part.part === "wrist" && part.ratio < 0.98));
});

test("shader A-B-A passes while stale binding, wrong styling, and stale CPU state are rejected", async () => {
  const contract = sceneContract("scene-shader-bindings", 2);
  const artifacts = shaderArtifacts(contract);
  assert.equal((await gradeSceneOutput({ ...contract, ...artifacts, fixtureUnchanged: true })).outcome, "pass");

  const stale = structuredClone(artifacts.result);
  stale.frames[1].color = stale.frames[0].color;
  assert.equal((await gradeSceneOutput({ ...contract, result: stale, readPng: artifacts.readPng, fixtureUnchanged: true })).checks.find((check) => check.name === "shader-pixels").ok, false);

  const wrongColor = structuredClone(artifacts.result);
  const changed = structuredClone(artifacts.images.get(wrongColor.frames[0].color));
  changed.data = new Uint8Array(changed.data);
  for (let offset = 0; offset < changed.data.length; offset += 4) if (changed.data[offset] !== 0) changed.data[offset] = 255;
  const readWrong = (path) => path === wrongColor.frames[0].color ? changed : artifacts.readPng(path);
  assert.equal((await gradeSceneOutput({ ...contract, result: wrongColor, readPng: readWrong, fixtureUnchanged: true })).checks.find((check) => check.name === "shader-pixels").ok, false);
  assert.equal((await gradeSceneOutput({ ...contract, ...artifacts, fixtureUnchanged: false })).checks.find((check) => check.name === "fixture-file-unmodified").ok, false);
});

test("warehouse stable identity, counts, coverage, centers, deletion, and output validation are gated", async () => {
  const contract = sceneContract("scene-warehouse", 2);
  const artifacts = warehouseArtifacts(contract);
  assert.equal((await gradeSceneOutput({ ...contract, ...artifacts })).outcome, "pass");

  const badIds = structuredClone(artifacts.result);
  const idPath = badIds.frames[3].ids;
  const changed = structuredClone(artifacts.images.get(idPath));
  changed.data = new Uint8Array(changed.data);
  changed.data.set([1, 0, 0, 255], 0);
  const grade = await gradeSceneOutput({ ...contract, result: badIds, readPng: (path) => path === idPath ? changed : artifacts.readPng(path) });
  assert.equal(grade.checks.find((check) => check.name === "warehouse-pixels").ok, false);

  const staleCount = structuredClone(artifacts.result);
  staleCount.frames[3].state.count = 2304;
  assert.equal((await gradeSceneOutput({ ...contract, result: staleCount, readPng: artifacts.readPng })).checks.find((check) => check.name === "warehouse-state").ok, false);

  const staleColor = structuredClone(artifacts.result);
  const colorPath = staleColor.frames[1].color;
  const colorImage = structuredClone(artifacts.images.get(colorPath));
  colorImage.data = new Uint8Array(colorImage.data);
  // appId 10290 started at x=-6.5,y=23.5 and is vacant in frame 1.
  const vacatedX = (-6.5 + 24) * 12;
  const vacatedY = (24 - 23.5) * 12;
  setPixel(colorImage, vacatedX, vacatedY, [255, 0, 0, 255]);
  const staleColorGrade = await gradeSceneOutput({
    ...contract,
    result: staleColor,
    readPng: (path) => path === colorPath ? colorImage : artifacts.readPng(path),
  });
  assert.equal(staleColorGrade.checks.find((check) => check.name === "warehouse-pixels").ok, false);

  const wrongProtocol = structuredClone(artifacts.result);
  wrongProtocol.frames.pop();
  assert.equal((await gradeSceneOutput({ ...contract, result: wrongProtocol, readPng: artifacts.readPng })).checks.find((check) => check.name === "protocol").ok, false);
  assert.equal((await gradeSceneOutput({ ...contract, result: artifacts.result, readPng: () => ({ width: 1, height: 1, data: new Uint8Array(4) }) })).outcome, "application-failure");
});

function findPixels(image, color) {
  const offsets = [];
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (color.every((value, channel) => image.data[offset + channel] === value)) offsets.push(offset);
  }
  return offsets;
}
