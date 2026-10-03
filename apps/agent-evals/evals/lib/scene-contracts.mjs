import { createHash } from "node:crypto";
import { sceneInteropContract, sceneInteropRevision, validateSceneInteropResult } from "./scene-interop.mjs";
import {
  SCENE_KEYFRAMES_TASK_ID,
  SCENE_KEYFRAMES_REVISION,
  sceneKeyframesContract,
  validateSceneKeyframesResult,
} from "./scene-keyframes.mjs";

export const SCENE_CONTRACT_REVISION = "scene-evals-v1";
export const SCENE_TASK_IDS = Object.freeze([
  "scene-robot-arm",
  "scene-shader-bindings",
  "scene-warehouse",
  "scene-math-interop",
  SCENE_KEYFRAMES_TASK_ID,
]);

const A = Object.freeze({
  basePosition: [-1.8, -0.7, 0],
  baseAngle: 0,
  shoulderAngle: 0,
  elbowAngle: 0,
  wristAngle: 0,
});
const B = Object.freeze({ ...A, shoulderAngle: 0.6 });
const C = Object.freeze({ ...B, basePosition: [-1.4, -0.2, 0], baseAngle: 0.35 });
const D = Object.freeze({ ...C, elbowAngle: -0.85, wristAngle: 0.25 });

const COLORS = Object.freeze([
  [1, 0, 0, 1],
  [0, 1, 0, 1],
  [0, 0, 1, 1],
  [0, 1, 1, 1],
  [1, 0, 1, 1],
  [1, 1, 0, 1],
]);

function warehouseItems() {
  return Array.from({ length: 48 * 48 }, (_, index) => ({
    appId: 10001 + 17 * index,
    position: [index % 48 - 23.5, 23.5 - Math.floor(index / 48), 0],
    tint: [...COLORS[index % COLORS.length]],
  }));
}

const WAREHOUSE_FRAMES = Object.freeze([
  { operations: [] },
  { operations: [{ op: "delete", appId: 10290 }] },
  {
    operations: [
      { op: "move", appId: 49152, position: [-6.5, 23.5, 0] },
      { op: "recolor", appId: 49152, tint: [0, 1, 1, 1] },
    ],
  },
  {
    operations: [
      { op: "delete", appId: 26950 },
      { op: "move", appId: 49135, position: [13.5, 3.5, 0] },
      { op: "recolor", appId: 49135, tint: [0, 0, 1, 1] },
      { op: "recolor", appId: 49152, tint: [1, 0, 1, 1] },
    ],
  },
]);

const PROMPTS = Object.freeze({
  "scene-robot-arm": [
    [
      "Build the headless robot-arm renderer described in contract.md.",
      "Its entry point must be `node render.mjs <input.json> <output-directory>`.",
      "Use `npx vgpu`.",
    ].join("\n"),
    [
      "Extend the renderer so one input batch may change basePosition and baseAngle, then independently change elbowAngle and wristAngle.",
      "Every pose field in every frame is an absolute replacement, never a delta. Render every frame in order in one invocation.",
      "Keep the original rest and shoulder poses working, including when the batch returns to the original pose.",
    ].join("\n"),
  ],
  "scene-shader-bindings": [
    [
      "Build the headless box renderer described in contract.md and use integration.wgsl unchanged.",
      "Its entry point must be `node render.mjs <input.json> <output-directory>`.",
      "Use `npx vgpu`.",
    ].join("\n"),
    [
      "Add camera-position updates. Each frame's cameraPosition is an absolute replacement.",
      "Camera orientation stays identity: translate the view by the negative camera position, and do not retarget it toward the origin.",
      "Render every frame in order in one invocation, upload the current camera binding for every frame, and keep object origins fixed.",
    ].join("\n"),
  ],
  "scene-warehouse": [
    [
      "Build the headless warehouse renderer described in contract.md.",
      "Its entry point must be `node render.mjs <input.json> <output-directory>`.",
      "Use `npx vgpu`.",
    ].join("\n"),
    [
      "Add frame operations addressed by stable appId: {\"op\":\"delete\",\"appId\":n}, {\"op\":\"move\",\"appId\":n,\"position\":[x,y,z]}, and {\"op\":\"recolor\",\"appId\":n,\"tint\":[r,g,b,a]}.",
      "Apply operations in order to one persistent inventory. Move and recolor replace the named value; a deleted item stays deleted.",
      "Render every frame in order in one invocation and keep application identity independent from packed storage or collection handles.",
    ].join("\n"),
  ],
});

export function sceneContract(taskId, stage) {
  requireSceneTask(taskId);
  if (stage !== 1 && stage !== 2) throw new TypeError(`scene stage must be 1 or 2, got ${stage}`);
  if (taskId === SCENE_KEYFRAMES_TASK_ID) return sceneKeyframesContract(stage);
  if (taskId === "scene-math-interop") return sceneInteropContract(stage);
  const requestId = `${taskId}-turn-${stage}`;
  let width;
  let height;
  let input;
  if (taskId === "scene-robot-arm") {
    width = 512;
    height = 384;
    input = { version: 1, requestId, frames: stage === 1 ? [A, B] : [A, B, C, D, A] };
  } else if (taskId === "scene-shader-bindings") {
    width = 512;
    height = 384;
    const initial = { cameraPosition: [0, 0, 8] };
    const moved = { cameraPosition: [0.8, 0.45, 8] };
    input = { version: 1, requestId, frames: stage === 1 ? [initial] : [initial, moved, initial] };
  } else if (taskId === "scene-warehouse") {
    width = 576;
    height = 576;
    input = {
      version: 1,
      requestId,
      items: warehouseItems(),
      frames: stage === 1 ? [WAREHOUSE_FRAMES[0]] : WAREHOUSE_FRAMES,
    };
  } else {
    throw new TypeError(`sceneContract has no dispatcher for ${JSON.stringify(taskId)}`);
  }
  return structuredClone({
    revision: SCENE_CONTRACT_REVISION,
    taskId,
    stage,
    width,
    height,
    timeoutMs: 60_000,
    prompt: PROMPTS[taskId][stage - 1],
    input,
  });
}

export function sceneContractRevision(taskId) {
  requireSceneTask(taskId);
  if (taskId === SCENE_KEYFRAMES_TASK_ID) return SCENE_KEYFRAMES_REVISION;
  return taskId === "scene-math-interop" ? sceneInteropRevision() : SCENE_CONTRACT_REVISION;
}

export function sceneFixturePaths(taskId) {
  requireSceneTask(taskId);
  if (taskId === SCENE_KEYFRAMES_TASK_ID) return [];
  if (taskId === "scene-shader-bindings") return ["integration.wgsl"];
  if (taskId === "scene-math-interop") return ["ecs/README.md", "ecs/world.mjs"];
  return [];
}

export function requireSceneTask(taskId) {
  if (!SCENE_TASK_IDS.includes(taskId)) {
    throw new TypeError(`unknown scene task ${JSON.stringify(taskId)}`);
  }
  return taskId;
}

export function validateSceneResult(taskId, input, result) {
  requireSceneTask(taskId);
  if (taskId === SCENE_KEYFRAMES_TASK_ID) return validateSceneKeyframesResult(input, result);
  if (taskId === "scene-math-interop") return validateSceneInteropResult(input, result);
  const errors = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) errors.push("result must be an object");
  if (result?.version !== 1) errors.push("version must be 1");
  if (result?.requestId !== input.requestId) errors.push("requestId must match input");
  if (!Array.isArray(result?.frames)) errors.push("frames must be an array");
  else {
    if (result.frames.length !== input.frames.length) errors.push("frame count must match input");
    result.frames.forEach((frame, index) => {
      if (frame?.index !== index) errors.push(`frame ${index}: index must be ${index}`);
      if (typeof frame?.color !== "string") errors.push(`frame ${index}: color path is required`);
      if (taskId === "scene-warehouse" && typeof frame?.ids !== "string") errors.push(`frame ${index}: ids path is required`);
      if (!frame?.state || typeof frame.state !== "object") errors.push(`frame ${index}: state is required`);
    });
  }
  return errors;
}

export function sceneInputSha256(input) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
