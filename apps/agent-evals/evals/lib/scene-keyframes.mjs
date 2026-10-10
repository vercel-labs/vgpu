import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

export const SCENE_KEYFRAMES_TASK_ID = "scene-quaternion-keyframes";
export const SCENE_KEYFRAMES_REVISION = "scene-quaternion-keyframes-v1";

const EXAMPLE_INPUT = Object.freeze({
  version: 1,
  requestId: "scene-quaternion-keyframes-example",
  keyframes: Object.freeze([
    Object.freeze({ time: 0, rotation: Object.freeze([0, 0, 0, 1]) }),
    Object.freeze({ time: 1, rotation: Object.freeze([0, 0, 0, 1]) }),
  ]),
  frames: Object.freeze([Object.freeze({ time: 0 })]),
});

const TURN_ONE_KEYFRAMES = Object.freeze([
  Object.freeze({ time: 0, rotation: Object.freeze([0.24321034680169396, -0.33036608954935215, -0.08852132690137686, 0.9076733711903687]) }),
  Object.freeze({ time: 1, rotation: Object.freeze([-0.8790685210116355, 0.10331671962053335, -0.2498860246486334, 0.392582686193075]) }),
  Object.freeze({ time: 2.5, rotation: Object.freeze([-0.7652226098598721, -0.47240199550695056, 0.4101044434471002, -0.1519376762532622]) }),
  Object.freeze({ time: 3, rotation: Object.freeze([-0.7364416464670871, -0.6183456451229764, 0.117223531499366, 0.24811490920360496]) }),
]);

const TURN_TWO_KEYFRAMES = Object.freeze([
  TURN_ONE_KEYFRAMES[0],
  TURN_ONE_KEYFRAMES[1],
  Object.freeze({ time: 2.5, rotation: Object.freeze(TURN_ONE_KEYFRAMES[2].rotation.map((value) => -value)) }),
  TURN_ONE_KEYFRAMES[3],
  Object.freeze({ time: 4, rotation: Object.freeze([0.7834732737843864, 0.3643775356971042, -0.2608382925791095, -0.43053690418975304]) }),
]);

const PROMPTS = Object.freeze([
  [
    "Build the headless keyframed-rotation renderer described in contract.md.",
    "Its entry point must be `node render.mjs <input.json> <output-directory>`.",
    "Use `npx vgpu`.",
  ].join("\n"),
  [
    "The animation now needs frame times before the first keyframe and after the last one. Update the renderer so those frames hold the first or last keyframe's orientation.",
    "Everything else in contract.md still applies.",
  ].join("\n"),
]);

const FRAME_TIMES = Object.freeze([
  Object.freeze([0, 0.22, 0.75, 1, 1.35, 2.1, 2.5, 2.8, 3]),
  Object.freeze([-0.5, 0, 0.75, 1.35, 2.1, 2.8, 3, 3.3, 3.7, 4, 4.6]),
]);

export function sceneKeyframesContract(stage) {
  if (stage !== 1 && stage !== 2) throw new TypeError(`scene stage must be 1 or 2, got ${stage}`);
  const input = {
    version: 1,
    requestId: `${SCENE_KEYFRAMES_TASK_ID}-turn-${stage}`,
    keyframes: stage === 1 ? TURN_ONE_KEYFRAMES : TURN_TWO_KEYFRAMES,
    frames: FRAME_TIMES[stage - 1].map((time) => ({ time })),
  };
  return structuredClone({
    revision: SCENE_KEYFRAMES_REVISION,
    taskId: SCENE_KEYFRAMES_TASK_ID,
    stage,
    width: 512,
    height: 384,
    timeoutMs: 60_000,
    prompt: PROMPTS[stage - 1],
    input,
    exampleInput: EXAMPLE_INPUT,
  });
}

export function keyframeWorldAt(keyframes, time) {
  if (!Array.isArray(keyframes) || keyframes.length < 2) {
    throw new TypeError("keyframes must contain at least two entries");
  }
  const clamped = Math.max(keyframes[0].time, Math.min(keyframes.at(-1).time, time));
  let index = keyframes.length - 2;
  for (let candidate = 0; candidate < keyframes.length - 1; candidate += 1) {
    if (clamped <= keyframes[candidate + 1].time) {
      index = candidate;
      break;
    }
  }
  const a = keyframes[index];
  const b = keyframes[index + 1];
  const u = (clamped - a.time) / (b.time - a.time);
  return quaternionMatrix(slerp(a.rotation, b.rotation, u));
}

export function keyframeMarkerCenters(world, width = 512, height = 384) {
  return [[2, 0, 0], [0, 2, 0], [0, 0, 2]].map(([x, y, z]) => {
    const worldX = world[0] * x + world[4] * y + world[8] * z;
    const worldY = world[1] * x + world[5] * y + world[9] * z;
    return [width * (worldX / 8 + 0.5), height * (0.5 - worldY / 6)];
  });
}

export function keyframeFixtureMetrics(input) {
  let maximumUnitError = 0;
  let maximumSegmentAngleDegrees = 0;
  for (let index = 0; index < input.keyframes.length; index += 1) {
    maximumUnitError = Math.max(
      maximumUnitError,
      Math.abs(1 - Math.hypot(...input.keyframes[index].rotation)),
    );
    if (index > 0) {
      const dot = Math.abs(input.keyframes[index - 1].rotation.reduce(
        (sum, value, part) => sum + value * input.keyframes[index].rotation[part],
        0,
      ));
      maximumSegmentAngleDegrees = Math.max(
        maximumSegmentAngleDegrees,
        2 * Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI,
      );
    }
  }
  let minimumProjectedSeparation = Infinity;
  let minimumEdgeDistance = Infinity;
  for (const { time } of input.frames) {
    const centers = keyframeMarkerCenters(keyframeWorldAt(input.keyframes, time));
    for (const [x, y] of centers) {
      minimumEdgeDistance = Math.min(minimumEdgeDistance, x, 512 - x, y, 384 - y);
    }
    for (let a = 0; a < centers.length; a += 1) {
      for (let b = a + 1; b < centers.length; b += 1) {
        minimumProjectedSeparation = Math.min(
          minimumProjectedSeparation,
          Math.hypot(centers[a][0] - centers[b][0], centers[a][1] - centers[b][1]),
        );
      }
    }
  }
  return {
    maximumUnitError,
    maximumSegmentAngleDegrees,
    minimumProjectedSeparation,
    minimumEdgeDistance,
  };
}

export async function gradeSceneKeyframes({ input, result, width, height, readPng }) {
  const checks = [];
  const protocolErrors = validateSceneKeyframesResult(input, result);
  checks.push({ name: "protocol", ok: protocolErrors.length === 0, metrics: { errors: protocolErrors } });
  if (protocolErrors.length > 0) return finishGrade(checks);

  const images = [];
  try {
    for (const frame of result.frames) {
      const image = await readPng(frame.color);
      if (!image || image.width !== width || image.height !== height) {
        throw new Error(`${frame.color} must decode as ${width}x${height} RGBA PNG`);
      }
      if (!(image.data instanceof Uint8Array) || image.data.length !== width * height * 4) {
        throw new Error(`${frame.color} has invalid RGBA bytes`);
      }
      images.push(image);
    }
  } catch (error) {
    checks.push({
      name: "artifacts",
      ok: false,
      metrics: { reason: error instanceof Error ? error.message : String(error) },
    });
    return finishGrade(checks);
  }
  checks.push({ name: "artifacts", ok: true, metrics: { frames: images.length } });

  let maximumAbsoluteError = 0;
  const failingStateFrames = [];
  for (let index = 0; index < input.frames.length; index += 1) {
    const expected = keyframeWorldAt(input.keyframes, input.frames[index].time);
    const observed = result.frames[index].state.world;
    let frameOk = true;
    expected.forEach((value, part) => {
      const error = Math.abs(value - observed[part]);
      maximumAbsoluteError = Math.max(maximumAbsoluteError, error);
      if (error > 1e-4) frameOk = false;
    });
    if (!frameOk) failingStateFrames.push(index + 1);
  }
  checks.push({
    name: "state",
    ok: failingStateFrames.length === 0,
    metrics: { maximumAbsoluteError, failingFrames: failingStateFrames },
  });

  const markerColors = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  const frameMetrics = [];
  const failingPixelFrames = [];
  for (let frameIndex = 0; frameIndex < input.frames.length; frameIndex += 1) {
    const expectedWorld = keyframeWorldAt(input.keyframes, input.frames[frameIndex].time);
    const centers = keyframeMarkerCenters(expectedWorld, width, height);
    const image = images[frameIndex];
    const blobs = markerColors.map(() => ({ area: 0, x: 0, y: 0 }));
    let nonBlack = 0;
    let contained = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const pixel = image.data.subarray(offset, offset + 4);
        const marker = markerColors.findIndex((color) => matchesColor(pixel, color, 2));
        if (marker !== -1) {
          blobs[marker].area += 1;
          blobs[marker].x += x + 0.5;
          blobs[marker].y += y + 0.5;
        }
        if (!matchesColor(pixel, [0, 0, 0], 2)) {
          nonBlack += 1;
          if (centers.some(([centerX, centerY]) =>
            Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY) <= Math.sqrt(3) * 0.2 * 64 + 3)) {
            contained += 1;
          }
        }
      }
    }
    let frameOk = nonBlack > 0 && contained / nonBlack >= 0.99;
    const observed = blobs.map((blob, marker) => {
      const centroid = blob.area > 0 ? [blob.x / blob.area, blob.y / blob.area] : [NaN, NaN];
      const centroidError = Math.hypot(
        centroid[0] - centers[marker][0],
        centroid[1] - centers[marker][1],
      );
      if (blob.area < 328 || blob.area > 1311 || centroidError > 3) frameOk = false;
      return { marker, area: blob.area, centroid, centroidError };
    });
    if (!frameOk) failingPixelFrames.push(frameIndex + 1);
    frameMetrics.push({
      frame: frameIndex + 1,
      nonBlack,
      contained,
      containedRatio: nonBlack === 0 ? 0 : contained / nonBlack,
      markers: observed,
    });
  }
  checks.push({
    name: "pixels",
    ok: failingPixelFrames.length === 0,
    metrics: { failingFrames: failingPixelFrames, frames: frameMetrics },
  });
  return finishGrade(checks);
}

export function validateSceneKeyframesResult(input, result) {
  const errors = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) errors.push("result must be an object");
  if (result?.version !== 1) errors.push("version must be 1");
  if (result?.requestId !== input.requestId) errors.push("requestId must match input");
  if (!Array.isArray(result?.frames)) errors.push("frames must be an array");
  else {
    if (result.frames.length !== input.frames.length) errors.push("frame count must match input");
    result.frames.forEach((frame, index) => {
      if (frame?.index !== index) errors.push(`frame ${index}: index must be ${index}`);
      if (!safeRelativePath(frame?.color)) errors.push(`frame ${index}: color must be a relative output path`);
      if (!finiteVector(frame?.state?.world, 16)) errors.push(`frame ${index}: world must contain 16 finite numbers`);
    });
  }
  return errors;
}

function finiteVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) return false;
  const path = normalize(value).replaceAll("\\", "/");
  return path !== ".." && !path.startsWith("../");
}

function matchesColor(pixel, color, tolerance) {
  return color.every((value, index) => Math.abs(pixel[index] - value) <= tolerance);
}

function finishGrade(checks) {
  return {
    outcome: checks.every((check) => check.ok) ? "pass" : "application-failure",
    checks,
  };
}

function slerp(a, b, u) {
  let aligned = b;
  let dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
  if (dot < 0) {
    aligned = b.map((value) => -value);
    dot = -dot;
  }
  const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  let out;
  if (theta < 1e-12) out = a.map((value, index) => value + u * (aligned[index] - value));
  else {
    const denominator = Math.sin(theta);
    const left = Math.sin((1 - u) * theta) / denominator;
    const right = Math.sin(u * theta) / denominator;
    out = a.map((value, index) => left * value + right * aligned[index]);
  }
  const length = Math.hypot(...out);
  return out.map((value) => value / length);
}

function quaternionMatrix([x, y, z, w]) {
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    0, 0, 0, 1,
  ];
}

export function sceneKeyframesInputSha256(input) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
