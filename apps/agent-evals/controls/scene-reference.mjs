import { prepareShader } from "@vgpu/wgsl/prepare";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { draw, frame, geometry, init, target } from "vgpu/node";
import { box, instances } from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";
import { PNG } from "pngjs";

const REFERENCE_SHADER = prepareShader(await readFile(new URL("./scene-reference.wgsl", import.meta.url), "utf8"));
const ATTRIBUTES = { tint: "float32x4", pickingId: "uint32" };
const BOUNDS = [-4, 4, -3, 3, 0.1, 20];

const taskId = process.env.VGPU_SCENE_CONTROL_TASK;
const fault = process.env.VGPU_SCENE_CONTROL_FAULT || "positive";
const [inputPath, outputDir] = process.argv.slice(2);
if (!inputPath || !outputDir) throw new Error("usage: node render.mjs <input.json> <output-directory>");
const input = JSON.parse(await readFile(inputPath, "utf8"));
await mkdir(outputDir, { recursive: true });

const gpu = await init();
try {
  const result = taskId === "scene-robot-arm"
    ? await renderRobot(gpu, input, outputDir, fault)
    : taskId === "scene-shader-bindings"
      ? await renderShader(gpu, input, outputDir, fault)
      : taskId === "scene-warehouse"
        ? await renderWarehouse(gpu, input, outputDir, fault)
        : (() => { throw new Error(`unknown VGPU_SCENE_CONTROL_TASK ${JSON.stringify(taskId)}`); })();
  await writeFile(`${outputDir}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
} finally {
  gpu.dispose();
}

async function renderRobot(gpu, batch, directory, selectedFault) {
  requireFault(selectedFault, ["positive", "reverse-order", "no-descendant-propagation", "frozen-image"]);
  const collection = instances({ capacity: 5, attributes: ATTRIBUTES });
  const colors = [[1, 1, 0, 1], [1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [1, 0, 1, 1]];
  const handles = colors.map((tint, index) => collection.add({ tint, pickingId: index + 1 }));
  const bridge = instanceGeometry(gpu, collection, { mesh: geometry(gpu, box({ size: 1 })) });
  const colorTarget = target(gpu, { size: [512, 384], format: "rgba8unorm", depth: true });
  const renderer = draw(gpu, {
    shader: REFERENCE_SHADER,
    geometry: bridge.geometry,
    entry: { vertex: "vs_main", fragment: "fs_color" },
    targets: [colorTarget],
  });
  renderer.set({ viewState: { viewProjection: viewProjection([0, 0, 8], BOUNDS) } });
  const outputFrames = [];
  let frozenWorlds;
  let lastHealthyJoints;
  for (let index = 0; index < batch.frames.length; index += 1) {
    const frameInput = batch.frames[index];
    let joints = robotJoints(frameInput, selectedFault === "reverse-order");
    if (selectedFault === "no-descendant-propagation" && index >= 2 && lastHealthyJoints) {
      joints = { base: joints.base, shoulder: lastHealthyJoints.shoulder, elbow: lastHealthyJoints.elbow, wrist: lastHealthyJoints.wrist, tip: lastHealthyJoints.tip };
    } else {
      lastHealthyJoints = joints;
    }
    const worlds = robotWorlds(joints);
    frozenWorlds ??= worlds;
    const rendered = selectedFault === "frozen-image" ? frozenWorlds : worlds;
    rendered.forEach((world, part) => collection.setWorld(handles[part], world));
    const count = bridge.publish();
    frame(gpu, (current) => current.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(renderer, { instances: count })));
    const color = `${String(index).padStart(3, "0")}-color.png`;
    await writeTarget(colorTarget, `${directory}/${color}`, 512, 384);
    outputFrames.push({ index, color, state: { joints } });
  }
  return { version: 1, requestId: batch.requestId, frames: outputFrames };
}

async function renderShader(gpu, batch, directory, selectedFault) {
  requireFault(selectedFault, ["positive", "omit-uniform-upload", "previous-camera", "wrong-style"]);
  const collection = instances({ capacity: 3, attributes: { tint: "float32x4" } });
  const origins = { left: [-1.5, -0.6, 0], right: [1.3, -0.4, 0], upper: [-0.1, 1, 0] };
  const values = [[origins.left, [1, 0, 0, 1]], [origins.right, [0, 1, 0, 1]], [origins.upper, [0, 0, 1, 1]]];
  const handles = values.map(([, tint]) => collection.add({ tint }));
  values.forEach(([origin], index) => collection.setWorld(handles[index], worldMatrix(origin, [0.6, 0.6, 0.6])));
  const bridge = instanceGeometry(gpu, collection, { mesh: geometry(gpu, box({ size: 1 })) });
  const colorTarget = target(gpu, { size: [512, 384], format: "rgba8unorm", depth: true });
  const shader = prepareShader(await readFile(new URL("./integration.wgsl", import.meta.url), "utf8"));
  const renderer = draw(gpu, {
    shader,
    geometry: bridge.geometry,
    entry: { vertex: "vs_main", fragment: "fs_main" },
    targets: [colorTarget],
  });
  renderer.set({ style: selectedFault === "wrong-style" ? { gain: 1, floor: 0 } : { gain: 0.75, floor: 0.125 } });
  const count = bridge.publish();
  const outputFrames = [];
  let previousMatrix;
  for (let index = 0; index < batch.frames.length; index += 1) {
    const matrix = viewProjection(batch.frames[index].cameraPosition, BOUNDS);
    if (selectedFault !== "omit-uniform-upload" || index === 0) {
      renderer.set({ viewState: { viewProjection: selectedFault === "previous-camera" && previousMatrix ? previousMatrix : matrix } });
    }
    frame(gpu, (current) => current.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(renderer, { instances: count })));
    const color = `${String(index).padStart(3, "0")}-color.png`;
    await writeTarget(colorTarget, `${directory}/${color}`, 512, 384);
    outputFrames.push({ index, color, state: { viewProjection: matrix, origins } });
    previousMatrix = matrix;
  }
  return { version: 1, requestId: batch.requestId, frames: outputFrames };
}

async function renderWarehouse(gpu, batch, directory, selectedFault) {
  requireFault(selectedFault, ["positive", "packed-slot-identity", "cached-count", "missed-publish", "index-ids", "retain-deleted"]);
  const items = new Map(batch.items.map((item) => [item.appId, cloneItem(item)]));
  const packedIds = batch.items.map((item) => item.appId);
  const initialSlots = new Map(packedIds.map((id, index) => [id, index]));
  const collection = instances({ capacity: batch.items.length, attributes: ATTRIBUTES });
  const handles = new Map();
  for (const item of batch.items) {
    const handle = collection.add({ tint: item.tint, pickingId: item.appId });
    collection.setWorld(handle, worldMatrix(item.position, [0.6, 0.6, 0.6]));
    handles.set(item.appId, handle);
  }
  const bridge = instanceGeometry(gpu, collection, { mesh: geometry(gpu, box({ size: 1 })) });
  const colorTarget = target(gpu, { size: [576, 576], format: "rgba8unorm", depth: true });
  const idTarget = target(gpu, { size: [576, 576], format: "rgba8unorm", depth: true });
  const colorRenderer = draw(gpu, { shader: REFERENCE_SHADER, geometry: bridge.geometry, entry: { vertex: "vs_main", fragment: "fs_color" }, targets: [colorTarget] });
  const idRenderer = draw(gpu, { shader: REFERENCE_SHADER, geometry: bridge.geometry, entry: { vertex: "vs_main", fragment: "fs_ids" }, targets: [idTarget] });
  const matrix = viewProjection([0, 0, 8], [-24, 24, -24, 24, 0.1, 20]);
  colorRenderer.set({ viewState: { viewProjection: matrix } });
  idRenderer.set({ viewState: { viewProjection: matrix } });
  let publishedCount = 0;
  const initialCount = batch.items.length;
  const outputFrames = [];
  for (let index = 0; index < batch.frames.length; index += 1) {
    for (const operation of batch.frames[index].operations) applyWarehouseOperation(operation);
    if (selectedFault === "index-ids") {
      for (const handle of handles.values()) collection.set(handle, { pickingId: collection.slotOf(handle) + 1 });
    }
    if (!(selectedFault === "missed-publish" && index === 2)) publishedCount = bridge.publish();
    const drawCount = selectedFault === "cached-count" ? initialCount : publishedCount;
    frame(gpu, (current) => {
      current.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(colorRenderer, { instances: drawCount }));
      current.pass({ target: idTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(idRenderer, { instances: drawCount }));
    });
    const color = `${String(index).padStart(3, "0")}-color.png`;
    const ids = `${String(index).padStart(3, "0")}-ids.png`;
    await writeTarget(colorTarget, `${directory}/${color}`, 576, 576);
    await writeTarget(idTarget, `${directory}/${ids}`, 576, 576);
    const stateItems = [...items.values()].map(cloneItem).sort((a, b) => a.appId - b.appId);
    outputFrames.push({ index, color, ids, state: { count: stateItems.length, items: stateItems } });
  }
  return { version: 1, requestId: batch.requestId, frames: outputFrames };

  function applyWarehouseOperation(operation) {
    if (selectedFault === "retain-deleted" && operation.op === "delete") return;
    let targetId = operation.appId;
    if (selectedFault === "packed-slot-identity") {
      const staleSlot = initialSlots.get(operation.appId);
      targetId = staleSlot === undefined ? undefined : packedIds[staleSlot];
    }
    if (targetId === undefined || !items.has(targetId)) return;
    const item = items.get(targetId);
    const handle = handles.get(targetId);
    if (operation.op === "delete") {
      const slot = packedIds.indexOf(targetId);
      if (slot !== -1) {
        packedIds[slot] = packedIds.at(-1);
        packedIds.pop();
      }
      collection.remove(handle);
      handles.delete(targetId);
      items.delete(targetId);
    } else if (operation.op === "move") {
      item.position = [...operation.position];
      collection.setWorld(handle, worldMatrix(item.position, [0.6, 0.6, 0.6]));
    } else if (operation.op === "recolor") {
      item.tint = [...operation.tint];
      collection.set(handle, { tint: item.tint });
    }
  }
}

function robotJoints(value, reverse) {
  const base = multiply(translation(value.basePosition), rotationZ(value.baseAngle));
  const shoulderLocal = multiply(translation([0, 0.35, 0]), rotationZ(value.shoulderAngle));
  const elbowLocal = multiply(translation([1.5, 0, 0]), rotationZ(value.elbowAngle));
  const wristLocal = multiply(translation([1.1, 0, 0]), rotationZ(value.wristAngle));
  const apply = (parent, local) => reverse ? multiply(local, parent) : multiply(parent, local);
  const shoulder = apply(base, shoulderLocal);
  const elbow = apply(shoulder, elbowLocal);
  const wrist = apply(elbow, wristLocal);
  const tip = apply(wrist, translation([0.5, 0, 0]));
  return { base, shoulder, elbow, wrist, tip };
}

function robotWorlds(joints) {
  return [
    worldFromJoint(joints.base, [0, 0, 0], [0.6, 0.5, 0.3]),
    worldFromJoint(joints.shoulder, [0.75, 0, 0], [1.5, 0.22, 0.25]),
    worldFromJoint(joints.elbow, [0.55, 0, 0], [1.1, 0.18, 0.2]),
    worldFromJoint(joints.wrist, [0.25, 0, 0], [0.5, 0.24, 0.2]),
    worldFromJoint(joints.tip, [0, 0, 0.2], [0.12, 0.12, 0.12]),
  ];
}

function worldFromJoint(joint, center, size) {
  return multiply(multiply(joint, translation(center)), scale(size));
}

function worldMatrix(position, size) {
  return multiply(translation(position), scale(size));
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

function rotationZ(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function scale([x, y, z]) {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
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

async function writeTarget(renderTarget, path, width, height) {
  const image = new PNG({ width, height });
  image.data.set(await renderTarget.color.read({ mipLevel: 0, region: "all" }));
  await writeFile(path, PNG.sync.write(image));
}

function cloneItem(item) {
  return { appId: item.appId, position: [...item.position], tint: [...item.tint] };
}

function requireFault(value, allowed) {
  if (!allowed.includes(value)) throw new Error(`unsupported control fault ${JSON.stringify(value)}; expected ${allowed.join(", ")}`);
}
