import { prepareShader } from "@vgpu/wgsl/prepare";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { draw, frame, geometry, init, target } from "vgpu/node";
import { box, instances, sphere } from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";
import { PNG } from "pngjs";

const BOUNDS = [-4, 4, -3, 3, 0.1, 20];
const fault = process.env.VGPU_SCENE_CONTROL_FAULT || "handwritten";
const REFERENCE_SHADER = prepareShader(await readFile(new URL(
  fault === "sphere" ? "./scene-keyframes-sphere.wgsl" : "./scene-reference.wgsl",
  import.meta.url,
), "utf8"));
const [inputPath, outputDir] = process.argv.slice(2);
if (!inputPath || !outputDir) throw new Error("usage: node render.mjs <input.json> <output-directory>");
const input = JSON.parse(await readFile(inputPath, "utf8"));
await mkdir(outputDir, { recursive: true });

requireFault(fault, [
  "handwritten",
  "math",
  "wgpu-matrix",
  "sphere",
  "nlerp",
  "euler-xyz-lerp",
  "index-uniform-time",
  "transposed-world",
  "wxyz-misread",
  "long-arc",
  "no-clamp",
  "stale-publish",
  "frame0-png-reuse",
  "swap-red-green",
]);

const gpu = await init();
try {
  const result = await renderKeyframes(gpu, input, outputDir, fault);
  await writeFile(`${outputDir}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
} finally {
  gpu.dispose();
}

async function renderKeyframes(gpu, batch, directory, selectedFault) {
  const markerShape = selectedFault === "sphere"
    ? sphere({ radius: 0.2, widthSegments: 24, heightSegments: 12 })
    : box({ size: 0.4 });
  const collection = instances({
    capacity: 3,
    attributes: { tint: "float32x4", pickingId: "uint32" },
  });
  const colors = selectedFault === "swap-red-green"
    ? [[0, 1, 0, 1], [1, 0, 0, 1], [0, 0, 1, 1]]
    : [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1]];
  const handles = colors.map((tint, index) => collection.add({ tint, pickingId: index + 1 }));
  const bridge = instanceGeometry(gpu, collection, { mesh: geometry(gpu, markerShape) });
  const colorTarget = target(gpu, { size: [512, 384], format: "rgba8unorm", depth: true });
  const renderer = draw(gpu, {
    shader: REFERENCE_SHADER,
    geometry: bridge.geometry,
    entry: { vertex: "vs_main", fragment: "fs_color" },
    targets: [colorTarget],
  });
  renderer.set({ viewState: { viewProjection: viewProjection([0, 0, 10], BOUNDS) } });

  const outputFrames = [];
  let previousWorld;
  let frameZeroPng;
  for (let index = 0; index < batch.frames.length; index += 1) {
    const world = await selectedWorld(batch.keyframes, batch.frames[index].time, selectedFault);
    const renderedWorld = selectedFault === "stale-publish" && previousWorld
      ? previousWorld
      : world;
    const localCenters = [[2, 0, 0], [0, 2, 0], [0, 0, 2]];
    localCenters.forEach((center, marker) => {
      collection.setWorld(handles[marker], multiply(renderedWorld, translation(center)));
    });
    const count = bridge.publish();
    frame(gpu, (current) => current.pass(
      { target: colorTarget, clear: [0, 0, 0, 1] },
      (pass) => pass.draw(renderer, { instances: count }),
    ));
    const color = `${String(index).padStart(3, "0")}-color.png`;
    const png = await readTarget(colorTarget, 512, 384);
    frameZeroPng ??= png;
    await writeFile(`${directory}/${color}`,
      selectedFault === "frame0-png-reuse" ? frameZeroPng : png);
    outputFrames.push({ index, color, state: { world } });
    previousWorld = world;
  }
  return { version: 1, requestId: batch.requestId, frames: outputFrames };
}

async function selectedWorld(keyframes, time, selectedFault) {
  const kernel = selectedFault === "nlerp"
    ? nlerp
    : selectedFault === "euler-xyz-lerp"
      ? eulerXyzLerp
      : selectedFault === "long-arc"
        ? longArcSlerp
        : selectedFault === "math"
          ? mathSlerp
          : selectedFault === "wgpu-matrix"
            ? wgpuMatrixSlerp
            : handwrittenSlerp;
  const values = selectedFault === "wxyz-misread"
    ? keyframes.map((entry) => ({
        ...entry,
        rotation: [entry.rotation[3], entry.rotation[0], entry.rotation[1], entry.rotation[2]],
      }))
    : keyframes;
  const { a, b, u } = selectedFault === "index-uniform-time"
    ? uniformIndexSegment(values, time)
    : keyframeSegment(values, time, selectedFault !== "no-clamp");
  const matrix = quaternionMatrix(await kernel(a.rotation, b.rotation, u));
  return selectedFault === "transposed-world" ? transpose(matrix) : matrix;
}

function keyframeSegment(keyframes, time, clamp) {
  const evaluated = clamp
    ? Math.max(keyframes[0].time, Math.min(keyframes.at(-1).time, time))
    : time;
  let index = evaluated < keyframes[0].time ? 0 : keyframes.length - 2;
  for (let candidate = 0; candidate < keyframes.length - 1; candidate += 1) {
    if (evaluated <= keyframes[candidate + 1].time) {
      index = candidate;
      break;
    }
  }
  const a = keyframes[index];
  const b = keyframes[index + 1];
  return { a, b, u: (evaluated - a.time) / (b.time - a.time) };
}

function uniformIndexSegment(keyframes, time) {
  const first = keyframes[0].time;
  const last = keyframes.at(-1).time;
  const position = Math.max(0, Math.min(keyframes.length - 1,
    (time - first) / (last - first) * (keyframes.length - 1)));
  const index = Math.min(keyframes.length - 2, Math.floor(position));
  return { a: keyframes[index], b: keyframes[index + 1], u: position - index };
}

function handwrittenSlerp(a, b, u) {
  let aligned = b;
  let dot = dot4(a, b);
  if (dot < 0) {
    aligned = b.map((value) => -value);
    dot = -dot;
  }
  const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  if (theta < 1e-12) return normalize4(a.map((value, index) => value + u * (aligned[index] - value)));
  const denominator = Math.sin(theta);
  return normalize4(a.map((value, index) =>
    Math.sin((1 - u) * theta) / denominator * value
    + Math.sin(u * theta) / denominator * aligned[index]));
}

function nlerp(a, b, u) {
  const aligned = dot4(a, b) < 0 ? b.map((value) => -value) : b;
  return normalize4(a.map((value, index) => value + u * (aligned[index] - value)));
}

function longArcSlerp(a, b, u) {
  const dot = Math.max(-1, Math.min(1, dot4(a, b)));
  const theta = Math.acos(dot);
  if (theta < 1e-12) return normalize4(a.map((value, index) => value + u * (b[index] - value)));
  const denominator = Math.sin(theta);
  return normalize4(a.map((value, index) =>
    Math.sin((1 - u) * theta) / denominator * value
    + Math.sin(u * theta) / denominator * b[index]));
}

function eulerXyzLerp(a, b, u) {
  const from = quaternionToEulerXyz(a);
  const to = quaternionToEulerXyz(b);
  return eulerXyzToQuaternion(from.map((value, index) => value + u * (to[index] - value)));
}

async function mathSlerp(a, b, u) {
  const { quat } = await import("math");
  return Array.from(quat.slerp([0, 0, 0, 1], a, b, u));
}

async function wgpuMatrixSlerp(a, b, u) {
  const { quat } = await import("wgpu-matrix");
  return Array.from(quat.slerp(a, b, u));
}

function quaternionToEulerXyz([x, y, z, w]) {
  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))),
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  ];
}

function eulerXyzToQuaternion([x, y, z]) {
  const [sx, sy, sz] = [Math.sin(x / 2), Math.sin(y / 2), Math.sin(z / 2)];
  const [cx, cy, cz] = [Math.cos(x / 2), Math.cos(y / 2), Math.cos(z / 2)];
  return normalize4([
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ]);
}

function quaternionMatrix([x, y, z, w]) {
  const [xx, yy, zz] = [x * x, y * y, z * z];
  const [xy, xz, yz] = [x * y, x * z, y * z];
  const [wx, wy, wz] = [w * x, w * y, w * z];
  return [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    0, 0, 0, 1,
  ];
}

function viewProjection(cameraPosition, [left, right, bottom, top, near, far]) {
  const projection = [
    2 / (right - left), 0, 0, 0,
    0, 2 / (top - bottom), 0, 0,
    0, 0, 1 / (near - far), 0,
    (right + left) / (left - right), (top + bottom) / (bottom - top), near / (near - far), 1,
  ];
  return multiply(projection, translation(cameraPosition.map((value) => -value)));
}

function translation([x, y, z]) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return out;
}

function transpose(matrix) {
  return matrix.map((_, index) => matrix[(index % 4) * 4 + Math.floor(index / 4)]);
}

function dot4(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function normalize4(value) {
  const length = Math.hypot(...value);
  return value.map((part) => part / length);
}

async function readTarget(renderTarget, width, height) {
  const image = new PNG({ width, height });
  image.data.set(await renderTarget.color.read({ mipLevel: 0, region: "all" }));
  return PNG.sync.write(image);
}

function requireFault(value, allowed) {
  if (!allowed.includes(value)) throw new Error(
    `unsupported control fault ${JSON.stringify(value)}; expected ${allowed.join(", ")}`,
  );
}
