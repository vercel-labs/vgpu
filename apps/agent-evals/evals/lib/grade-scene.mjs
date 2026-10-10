import { isAbsolute, normalize } from "node:path";
import { validateSceneResult } from "./scene-contracts.mjs";
import {
  applyWarehouseFrames,
  containsConvexPoint,
  finiteVector,
  matrixWithBox,
  projectedRectangle,
  robotJoints,
  viewProjection,
} from "./scene-math.mjs";

const BLACK = [0, 0, 0, 255];
const PROJECTION = {
  cameraPosition: [0, 0, 8],
  bounds: [-4, 4, -3, 3, 0.1, 20],
};
const ROBOT_PARTS = [
  { joint: "base", center: [0, 0, 0], dimensions: [0.6, 0.5, 0.3], color: [255, 255, 0, 255], depth: 0.15 },
  { joint: "shoulder", center: [0.75, 0, 0], dimensions: [1.5, 0.22, 0.25], color: [255, 0, 0, 255], depth: 0.125 },
  { joint: "elbow", center: [0.55, 0, 0], dimensions: [1.1, 0.18, 0.2], color: [0, 255, 0, 255], depth: 0.1 },
  { joint: "wrist", center: [0.25, 0, 0], dimensions: [0.5, 0.24, 0.2], color: [0, 0, 255, 255], depth: 0.1 },
  { joint: "tip", center: [0, 0, 0.2], dimensions: [0.12, 0.12, 0.12], color: [255, 0, 255, 255], depth: 0.26 },
];
const SHADER_BOXES = [
  { name: "left", origin: [-1.5, -0.6, 0], color: [223, 32, 32, 255] },
  { name: "right", origin: [1.3, -0.4, 0], color: [32, 223, 32, 255] },
  { name: "upper", origin: [-0.1, 1, 0], color: [32, 32, 223, 255] },
];

export async function gradeSceneOutput({ taskId, input, result, width, height, readPng, fixtureUnchanged = true }) {
  const checks = [];
  const protocolErrors = validateSceneResult(taskId, input, result);
  add(checks, "protocol", protocolErrors.length === 0, { errors: protocolErrors });
  if (protocolErrors.length > 0) return finish(checks);

  try {
    const images = [];
    for (const frame of result.frames) {
      images.push({
        color: await readImage(readPng, frame.color, width, height),
        ids: frame.ids === undefined ? undefined : await readImage(readPng, frame.ids, width, height),
      });
    }
    if (taskId === "scene-robot-arm") gradeRobot(input, result, images, width, height, checks);
    else if (taskId === "scene-shader-bindings") gradeShader(input, result, images, width, height, fixtureUnchanged, checks);
    else if (taskId === "scene-warehouse") gradeWarehouse(input, result, images, width, height, checks);
    else throw new TypeError(`gradeSceneOutput does not support task ${JSON.stringify(taskId)}`);
  } catch (error) {
    if (error instanceof SceneVerifierError) {
      add(checks, "verifier", false, { reason: error.message });
      return { outcome: "infrastructure-error", checks };
    }
    add(checks, "artifacts", false, { reason: error instanceof Error ? error.message : String(error) });
  }
  return finish(checks);
}

function finish(checks) {
  return {
    outcome: checks.every((check) => check.ok) ? "pass" : "application-failure",
    checks,
  };
}

function add(checks, name, ok, metrics = {}) {
  checks.push({ name, ok: Boolean(ok), metrics });
}

async function readImage(readPng, path, width, height) {
  if (!safeRelativePath(path)) throw new Error(`output path escapes its directory: ${JSON.stringify(path)}`);
  const image = await readPng(path);
  if (!image || image.width !== width || image.height !== height) {
    throw new Error(`${path} must decode as ${width}x${height} RGBA PNG`);
  }
  if (!(image.data instanceof Uint8Array) && !Buffer.isBuffer(image.data)) throw new Error(`${path} has no RGBA bytes`);
  if (image.data.length !== width * height * 4) throw new Error(`${path} has the wrong RGBA byte length`);
  return image;
}

function safeRelativePath(path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) return false;
  const normalized = normalize(path).replaceAll("\\", "/");
  return normalized !== ".." && !normalized.startsWith("../");
}

function gradeRobot(input, result, images, width, height, checks) {
  let matrixWorst = 0;
  let matricesOk = true;
  let pixelExpected = 0;
  let pixelMatched = 0;
  let tipExpected = 0;
  let tipMatched = 0;
  let nonBackground = 0;
  let leaked = 0;
  const parts = [];
  const frames = [];
  const failingFrames = new Set();
  for (let frameIndex = 0; frameIndex < input.frames.length; frameIndex += 1) {
    const expectedJoints = robotJoints(input.frames[frameIndex]);
    const observed = result.frames[frameIndex].state?.joints;
    for (const name of Object.keys(expectedJoints)) {
      const matrix = observed?.[name];
      if (!finiteVector(matrix, 16)) {
        matricesOk = false;
        continue;
      }
      expectedJoints[name].forEach((value, index) => {
        const error = Math.abs(value - matrix[index]);
        matrixWorst = Math.max(matrixWorst, error);
        if (error > 1e-4) matricesOk = false;
      });
    }
    const shapes = ROBOT_PARTS.map((part) => ({
      ...part,
      polygon: projectedRectangle(matrixWithBox(expectedJoints[part.joint], part.center, part.dimensions), {
        width,
        height,
        ...PROJECTION,
      }),
    }));
    const image = images[frameIndex].color;
    const frameParts = new Map(shapes.map((shape) => [shape.joint, { expected: 0, matched: 0 }]));
    let frameNonBackground = 0;
    let frameLeaked = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const point = [x + 0.5, y + 0.5];
        // Resolve visibility against raw silhouettes first. A foreground edge
        // can cover the eroded interior of a shape behind it; treating only
        // eroded masks as occluders would incorrectly expect the hidden color.
        const frontmost = shapes
          .filter((shape) => containsConvexPoint(shape.polygon, point, 0))
          .sort((a, b) => b.depth - a.depth)[0];
        const expected = frontmost && containsConvexPoint(frontmost.polygon, point, 2) ? frontmost : undefined;
        const actual = pixel(image, x, y);
        if (expected) {
          const stats = frameParts.get(expected.joint);
          stats.expected += 1;
          pixelExpected += 1;
          if (matches(actual, expected.color, 2)) {
            stats.matched += 1;
            pixelMatched += 1;
          }
          if (expected.joint === "tip") {
            tipExpected += 1;
            if (matches(actual, expected.color, 2)) tipMatched += 1;
          }
        }
        if (!matches(actual, BLACK, 2)) {
          frameNonBackground += 1;
          nonBackground += 1;
          if (!shapes.some((shape) => withinDilatedPolygon(shape.polygon, point, 2))) {
            frameLeaked += 1;
            leaked += 1;
          }
        }
      }
    }
    let frameOk = true;
    for (const shape of shapes) {
      const stats = frameParts.get(shape.joint);
      if (stats.expected === 0) throw new SceneVerifierError(`robot frame ${frameIndex + 1} ${shape.joint} expected mask is empty`);
      const ratio = stats.matched / stats.expected;
      parts.push({ frame: frameIndex + 1, part: shape.joint, expected: stats.expected, matched: stats.matched, ratio });
      if (ratio < 0.98) frameOk = false;
    }
    const containedRatio = frameNonBackground === 0 ? 0 : 1 - frameLeaked / frameNonBackground;
    if (containedRatio < 0.99) frameOk = false;
    if (!frameOk) failingFrames.add(frameIndex + 1);
    frames.push({ frame: frameIndex + 1, nonBackground: frameNonBackground, leaked: frameLeaked, containedRatio });
  }
  const pixelRatio = pixelExpected === 0 ? 0 : pixelMatched / pixelExpected;
  const tipRatio = tipExpected === 0 ? 0 : tipMatched / tipExpected;
  const containedRatio = nonBackground === 0 ? 0 : 1 - leaked / nonBackground;
  add(checks, "robot-matrices", matricesOk, { maxAbsoluteError: matrixWorst });
  const minimumPartRatio = Math.min(...parts.map((part) => part.ratio));
  const minimumFrameContainedRatio = Math.min(...frames.map((frame) => frame.containedRatio));
  add(checks, "robot-pixels", failingFrames.size === 0, {
    pixelExpected,
    pixelRatio,
    tipExpected,
    tipRatio,
    containedRatio,
    minimumPartRatio,
    minimumFrameContainedRatio,
    failingFrames: [...failingFrames],
    parts,
    frames,
  });
}

function gradeShader(input, result, images, width, height, fixtureUnchanged, checks) {
  add(checks, "fixture-file-unmodified", fixtureUnchanged, {});
  let stateOk = true;
  let matrixWorst = 0;
  let expectedPixels = 0;
  let matchedPixels = 0;
  let nonBackground = 0;
  let leaked = 0;
  for (let frameIndex = 0; frameIndex < input.frames.length; frameIndex += 1) {
    const cameraPosition = input.frames[frameIndex].cameraPosition;
    const expectedMatrix = viewProjection(cameraPosition, PROJECTION.bounds);
    const state = result.frames[frameIndex].state;
    if (!finiteVector(state?.viewProjection, 16)) stateOk = false;
    else expectedMatrix.forEach((value, index) => {
      const error = Math.abs(value - state.viewProjection[index]);
      matrixWorst = Math.max(matrixWorst, error);
      if (error > 1e-4) stateOk = false;
    });
    for (const box of SHADER_BOXES) {
      if (!finiteVector(state?.origins?.[box.name], 3)) stateOk = false;
      else box.origin.forEach((value, index) => { if (Math.abs(value - state.origins[box.name][index]) > 1e-4) stateOk = false; });
    }
    const shapes = SHADER_BOXES.map((box) => {
      const center = projectBoxCenter(box.origin, cameraPosition, width, height);
      return { ...box, polygon: rectangle(center, 0.6 * width / 8, 0.6 * height / 6) };
    });
    const image = images[frameIndex].color;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const point = [x + 0.5, y + 0.5];
        const expected = shapes.find((shape) => containsConvexPoint(shape.polygon, point, 2));
        const actual = pixel(image, x, y);
        if (expected) {
          expectedPixels += 1;
          if (matches(actual, expected.color, 2)) matchedPixels += 1;
        }
        if (!matches(actual, BLACK, 2)) {
          nonBackground += 1;
          if (!shapes.some((shape) => withinDilatedPolygon(shape.polygon, point, 2))) leaked += 1;
        }
      }
    }
  }
  const colorRatio = expectedPixels === 0 ? 0 : matchedPixels / expectedPixels;
  const containedRatio = nonBackground === 0 ? 0 : 1 - leaked / nonBackground;
  add(checks, "shader-state", stateOk, { maxAbsoluteError: matrixWorst });
  add(checks, "shader-pixels", expectedPixels > 0 && colorRatio >= 0.98 && containedRatio >= 0.99, { expectedPixels, colorRatio, containedRatio });
}

function gradeWarehouse(input, result, images, width, height, checks) {
  const expectedStates = applyWarehouseFrames(input.items, input.frames);
  let stateOk = true;
  let pixelsOk = true;
  let worstCoverage = Infinity;
  let bestCoverage = 0;
  let centerSamples = 0;
  let centerMatches = 0;
  const failingStateFrames = [];
  const failingPixelFrames = [];
  for (let frameIndex = 0; frameIndex < expectedStates.length; frameIndex += 1) {
    let frameStateOk = true;
    let framePixelsOk = true;
    const expected = expectedStates[frameIndex];
    const observed = result.frames[frameIndex].state;
    if (observed?.count !== expected.count || !Array.isArray(observed?.items) || observed.items.length !== expected.count) {
      frameStateOk = false;
    } else {
      for (let index = 0; index < expected.items.length; index += 1) {
        const a = expected.items[index];
        const b = observed.items[index];
        if (b?.appId !== a.appId || !finiteVector(b?.position, 3) || !finiteVector(b?.tint, 4)) frameStateOk = false;
        else if (a.position.some((value, part) => Math.abs(value - b.position[part]) > 1e-4) || a.tint.some((value, part) => Math.abs(value - b.tint[part]) > 1e-4)) frameStateOk = false;
      }
    }
    const live = new Map(expected.items.map((item) => [item.appId, item]));
    const coverage = new Map();
    const idSet = new Set();
    const ids = images[frameIndex].ids;
    const colors = images[frameIndex].color;
    if (!ids) {
      framePixelsOk = false;
      continue;
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = decodeId(pixel(ids, x, y));
        const color = pixel(colors, x, y);
        if (value === 0) {
          // The color and ID passes represent the same published geometry.
          // This catches retained/deleted color geometry paired with a freshly
          // cleared ID pass, including vacated cells.
          if (!matches(color, BLACK, 2)) framePixelsOk = false;
          continue;
        }
        idSet.add(value);
        coverage.set(value, (coverage.get(value) ?? 0) + 1);
        const item = live.get(value);
        if (!item) {
          framePixelsOk = false;
          continue;
        }
        const expectedColor = item.tint.map((channel, index) => index === 3 ? 255 : Math.round(channel * 255));
        if (!matches(color, expectedColor, 2)) framePixelsOk = false;
        const [centerX, centerY] = warehouseCenter(item.position, width, height);
        if (Math.abs(x + 0.5 - centerX) > 4.6 || Math.abs(y + 0.5 - centerY) > 4.6) framePixelsOk = false;
      }
    }
    if (idSet.size !== live.size || [...live.keys()].some((id) => !idSet.has(id))) framePixelsOk = false;
    for (const item of expected.items) {
      const count = coverage.get(item.appId) ?? 0;
      worstCoverage = Math.min(worstCoverage, count);
      bestCoverage = Math.max(bestCoverage, count);
      if (count < 40 || count > 81) framePixelsOk = false;
      const [centerX, centerY] = warehouseCenter(item.position, width, height);
      const idColor = [item.appId & 255, (item.appId >> 8) & 255, (item.appId >> 16) & 255, 255];
      const expectedColor = item.tint.map((value, channel) => channel === 3 ? 255 : Math.round(value * 255));
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const x = Math.floor(centerX) + dx;
          const y = Math.floor(centerY) + dy;
          centerSamples += 1;
          if (matches(pixel(ids, x, y), idColor, 0) && matches(pixel(colors, x, y), expectedColor, 2)) centerMatches += 1;
          else framePixelsOk = false;
        }
      }
    }
    stateOk &&= frameStateOk;
    pixelsOk &&= framePixelsOk;
    if (!frameStateOk) failingStateFrames.push(frameIndex + 1);
    if (!framePixelsOk) failingPixelFrames.push(frameIndex + 1);
  }
  add(checks, "warehouse-state", stateOk, { failingFrames: failingStateFrames });
  add(checks, "warehouse-pixels", pixelsOk && centerSamples > 0, {
    centerSamples,
    centerMatches,
    minimumIdCoverage: Number.isFinite(worstCoverage) ? worstCoverage : 0,
    maximumIdCoverage: bestCoverage,
    failingFrames: failingPixelFrames,
  });
}

function projectBoxCenter(origin, cameraPosition, width, height) {
  return [
    width * ((origin[0] - cameraPosition[0]) / 8 + 0.5),
    height * (0.5 - (origin[1] - cameraPosition[1]) / 6),
  ];
}

function rectangle(center, width, height) {
  return [
    [center[0] - width / 2, center[1] - height / 2],
    [center[0] + width / 2, center[1] - height / 2],
    [center[0] + width / 2, center[1] + height / 2],
    [center[0] - width / 2, center[1] + height / 2],
  ];
}

function withinDilatedPolygon(polygon, point, amount) {
  if (containsConvexPoint(polygon, point, 0)) return true;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    if (distanceToSegment(point, a, b) <= amount) return true;
  }
  return false;
}

function distanceToSegment(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

function warehouseCenter(position, width, height) {
  return [(position[0] + 24) * width / 48, (24 - position[1]) * height / 48];
}

function decodeId(rgba) {
  return rgba[0] | (rgba[1] << 8) | (rgba[2] << 16);
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return image.data.subarray(offset, offset + 4);
}

function matches(actual, expected, tolerance) {
  return expected.every((value, index) => Math.abs(actual[index] - value) <= tolerance);
}

class SceneVerifierError extends Error {}
