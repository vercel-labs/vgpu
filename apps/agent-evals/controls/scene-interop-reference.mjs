import { prepareShader } from "@vgpu/wgsl/prepare";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mat4 } from "math";
import { draw, frame, geometry, init, target } from "vgpu/node";
import { box, instances } from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";
import { PNG } from "pngjs";
import { createWorld } from "./ecs/world.mjs";

const SHADER = prepareShader(await readFile(new URL("./scene-reference.wgsl", import.meta.url), "utf8"));
const fault = process.env.VGPU_SCENE_CONTROL_FAULT || "positive";
const allowed = [
  "positive", "reverse-order", "double-parent", "shear-loss", "ortho-no", "stale-camera",
  "descendant-update-omission", "missed-publish", "turn1-only", "key-as-row", "orphan-instances",
  "camera-local", "cached-count",
];
if (!allowed.includes(fault)) throw new Error(`unsupported control fault ${JSON.stringify(fault)}`);
const [inputPath, outputDir] = process.argv.slice(2);
if (!inputPath || !outputDir) throw new Error("usage: node render.mjs <input.json> <output-directory>");
const input = JSON.parse(await readFile(inputPath, "utf8"));
await mkdir(outputDir, { recursive: true });
if (fault === "turn1-only" && input.frames.some((entry) => entry.commands.some((command) => command.op !== "set"))) {
  throw new Error("turn-one renderer supports set commands only");
}

const world = createWorld({ capacity: 64 });
const handles = [];
for (const entity of input.entities) handles.push(world.spawn({ ...entity, parent: entity.parent == null ? null : handles[entity.parent] }));
const collection = instances({ capacity: 64, attributes: { tint: "float32x4", pickingId: "uint32" } });
const instanceHandles = new Map();
const gpu = await init();
try {
  const bridge = instanceGeometry(gpu, collection, { mesh: geometry(gpu, box({ size: 1 })) });
  const output = target(gpu, { size: [512, 384], format: "rgba8unorm", depth: true });
  const renderer = draw(gpu, { shader: SHADER, geometry: bridge.geometry, entry: { vertex: "vs_main", fragment: "fs_color" }, targets: [output] });
  const resultFrames = [];
  let publishedCount = 0;
  let initialCount = 0;
  let frozenCamera;
  const staleWorlds = new Map();

  for (let index = 0; index < input.frames.length; index += 1) {
    const directlySet = new Set();
    for (const command of input.frames[index].commands) {
      if (command.op === "set") {
        directlySet.add(command.key);
        if (command.position) world.setPosition(handles[command.key], command.position);
        if (command.rotation) world.setRotation(handles[command.key], command.rotation);
        if (command.scale) world.setScale(handles[command.key], command.scale);
      } else if (command.op === "spawn") {
        handles.push(world.spawn({ ...command, parent: command.parent == null ? null : handles[command.parent] }));
      } else if (command.op === "parent") {
        world.setParent(handles[command.key], command.parent == null ? null : handles[command.parent]);
      } else if (command.op === "despawn") {
        world.despawn(handles[command.key]);
      }
    }
    world.update();

    const liveKeys = handles.flatMap((handle, key) => world.isAlive(handle) ? [key] : []);
    for (const key of [...instanceHandles.keys()]) {
      if (!liveKeys.includes(key) && fault !== "orphan-instances") {
        collection.remove(instanceHandles.get(key));
        instanceHandles.delete(key);
      }
    }
    for (const key of liveKeys) {
      const handle = handles[key];
      const renderable = world.renderable(handle);
      if (!renderable) continue;
      let instance = instanceHandles.get(key);
      if (instance === undefined) {
        instance = collection.add({ tint: renderable.color.map((value) => value / 255).concat(1), pickingId: key + 1 });
        instanceHandles.set(key, instance);
      }
      const row = world.rowOf(handle);
      const clean = Array.from(world.worldMatrices.subarray(row * 16, row * 16 + 16));
      let renderedWorld = clean;
      if (fault === "descendant-update-omission" && index > 0 && !directlySet.has(key) && staleWorlds.has(key)) renderedWorld = staleWorlds.get(key);
      else staleWorlds.set(key, clean);
      if (fault === "key-as-row" && key >= input.entities.length) {
        const wrongRow = key % 9;
        renderedWorld = Array.from(world.worldMatrices.subarray(wrongRow * 16, wrongRow * 16 + 16));
      }
      if (fault === "double-parent" && world.parentOf(handle) !== null) {
        const parentRow = world.rowOf(world.parentOf(handle));
        renderedWorld = multiply(Array.from(world.worldMatrices.subarray(parentRow * 16, parentRow * 16 + 16)), renderedWorld);
      }
      if (fault === "shear-loss" && world.parentOf(handle) !== null) renderedWorld = decomposeRecompose(renderedWorld);
      const offset = translation(renderable.offset);
      const size = scale(renderable.size);
      const mesh = fault === "reverse-order"
        ? multiply(multiply(offset, size), renderedWorld)
        : multiply(multiply(renderedWorld, offset), size);
      collection.setWorld(instance, mesh);
    }

    const cameraKey = liveKeys.find((key) => world.camera(handles[key]));
    const cameraHandle = handles[cameraKey];
    const cameraRow = world.rowOf(cameraHandle);
    const cameraWorld = Array.from(world.worldMatrices.subarray(cameraRow * 16, cameraRow * 16 + 16));
    const bounds = world.camera(cameraHandle);
    const correctVp = multiply(projection(bounds, false), invert(cameraWorld));
    let renderVp = correctVp;
    if (fault === "ortho-no") renderVp = multiply(projection(bounds, true), invert(cameraWorld));
    if (fault === "camera-local") renderVp = multiply(projection(bounds, false), invert(Array.from(world.localMatrices.subarray(cameraRow * 16, cameraRow * 16 + 16))));
    frozenCamera ??= renderVp;
    if (fault === "stale-camera" && index > 0) renderVp = frozenCamera;
    renderer.set({ viewState: { viewProjection: renderVp } });

    if (!(fault === "missed-publish" && index > 0)) publishedCount = bridge.publish();
    if (index === 0) initialCount = publishedCount;
    const count = fault === "cached-count" ? initialCount : publishedCount;
    frame(gpu, (current) => current.pass({ target: output, clear: [0, 0, 0, 1] }, (pass) => pass.draw(renderer, { instances: count })));
    const color = `${String(index).padStart(3, "0")}-color.png`;
    const image = new PNG({ width: 512, height: 384 });
    image.data.set(await output.color.read({ mipLevel: 0, region: "all" }));
    await writeFile(`${outputDir}/${color}`, PNG.sync.write(image));

    const stateEntities = liveKeys.map((key) => {
      let row = world.rowOf(handles[key]);
      if (fault === "key-as-row" && key >= input.entities.length) row = key % 9;
      return { key, world: Array.from(world.worldMatrices.subarray(row * 16, row * 16 + 16)) };
    });
    const stateVp = fault === "ortho-no" ? renderVp : fault === "camera-local" ? renderVp : correctVp;
    resultFrames.push({ index, color, state: { viewProjection: stateVp, entities: stateEntities } });
  }
  await writeFile(`${outputDir}/result.json`, `${JSON.stringify({ version: 1, requestId: input.requestId, frames: resultFrames }, null, 2)}\n`);
} finally {
  gpu.dispose();
}

function projection(value, no) {
  const out = mat4.create();
  (no ? mat4.orthoNO : mat4.orthoZO)(out, value.left, value.right, value.bottom, value.top, value.near, value.far);
  return out;
}

function invert(value) {
  const out = mat4.create();
  if (!mat4.invert(out, value)) throw new Error("camera matrix is singular");
  return out;
}

function translation([x, y, z]) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; }
function scale([x, y, z]) { return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]; }
function multiply(a, b) { const out = new Array(16); mat4.multiply(out, a, b); return out; }
function decomposeRecompose(value) {
  const sx = Math.hypot(value[0], value[1], value[2]);
  const sy = Math.hypot(value[4], value[5], value[6]);
  const angle = Math.atan2(value[1] / sx, value[0] / sx);
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c * sx, s * sx, 0, 0, -s * sy, c * sy, 0, 0, 0, 0, value[10], 0, value[12], value[13], value[14], 1];
}
