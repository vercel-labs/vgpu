import {
  containsConvexPoint,
  multiply4,
  orthographic,
  scale4,
  transformPoint,
  translation,
} from "./scene-math.mjs";
import { isAbsolute, normalize } from "node:path";

const REVISION = "scene-math-interop-v1";
const IDENTITY_ROTATION = Object.freeze([0, 0, 0, 1]);

function rotationZ(angle) {
  return [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
}

const ENTITIES = Object.freeze([
  {
    parent: null,
    position: [0, 0, 10],
    rotation: IDENTITY_ROTATION,
    scale: [1, 1, 1],
    camera: { left: -4, right: 4, bottom: -3, top: 3, near: 0.1, far: 20 },
  },
  {
    parent: null,
    position: [-2, -1, 0],
    rotation: IDENTITY_ROTATION,
    scale: [1.6, 0.8, 1],
    renderable: { size: [1, 1, 0.4], offset: [0, 0, 0], color: [255, 0, 0] },
  },
  {
    parent: 1,
    position: [0.75, 0.75, 0.5],
    rotation: rotationZ(Math.PI / 6),
    scale: [1, 1, 1],
    renderable: { size: [1, 0.5, 0.4], offset: [0.5, 0, 0], color: [0, 255, 0] },
  },
  {
    parent: 2,
    position: [1, 0, 0.6],
    rotation: rotationZ(-Math.PI / 4),
    scale: [1, 1, 1],
    renderable: { size: [0.4, 0.4, 0.4], offset: [0, 0, 0], color: [0, 0, 255] },
  },
  {
    parent: null,
    position: [2.5, 1.8, 4],
    rotation: IDENTITY_ROTATION,
    scale: [1, 1, 1],
    renderable: { size: [0.6, 0.6, 0.6], offset: [0, 0, 0], color: [255, 255, 0] },
  },
  {
    parent: null,
    position: [2, -1.5, 1],
    rotation: IDENTITY_ROTATION,
    scale: [1, 1, 1],
    renderable: { size: [1.2, 1.2, 0.2], offset: [0, 0, 0], color: [255, 0, 255] },
  },
  {
    parent: null,
    position: [2.5, -1.1, -1],
    rotation: IDENTITY_ROTATION,
    scale: [1, 1, 1],
    renderable: { size: [1.2, 1.2, 0.2], offset: [0, 0, 0], color: [0, 255, 255] },
  },
  {
    parent: null,
    position: [-2.5, 1.5, -2],
    rotation: IDENTITY_ROTATION,
    scale: [1, 1, 1],
    renderable: { size: [1.2, 1.2, 0.2], offset: [0, 0, 0], color: [255, 128, 0] },
  },
  {
    parent: null,
    position: [-2, 1.9, 0.5],
    rotation: IDENTITY_ROTATION,
    scale: [1, 1, 1],
    renderable: { size: [1.2, 1.2, 0.2], offset: [0, 0, 0], color: [128, 0, 255] },
  },
]);

const TURN_ONE_FRAMES = Object.freeze([
  { commands: [] },
  {
    commands: [{
      op: "set",
      key: 1,
      position: [-1.5, -0.5, 0],
      rotation: rotationZ(Math.PI / 12),
    }],
  },
  {
    commands: [
      { op: "set", key: 2, scale: [1.5, 1, 1] },
      { op: "set", key: 0, position: [0.5, 0.25, 10] },
    ],
  },
  {
    commands: [
      { op: "set", key: 1, position: [-2, -1, 0], rotation: IDENTITY_ROTATION },
      { op: "set", key: 2, scale: [1, 1, 1] },
      { op: "set", key: 0, position: [0, 0, 10] },
    ],
  },
]);

const TURN_TWO_FRAMES = Object.freeze([
  { commands: [] },
  {
    commands: [
      { op: "spawn", parent: null, position: [0, 0, 0], rotation: IDENTITY_ROTATION, scale: [1, 1, 1] },
      { op: "parent", key: 0, parent: 9 },
      { op: "set", key: 9, position: [0.3, 0, 0], rotation: rotationZ(Math.PI / 30) },
      { op: "despawn", key: 3 },
    ],
  },
  {
    commands: [
      {
        op: "spawn",
        parent: 2,
        position: [1, 0, 0.6],
        rotation: IDENTITY_ROTATION,
        scale: [1, 1, 1],
        renderable: { size: [0.3, 0.6, 0.4], offset: [0, 0, 0], color: [255, 255, 255] },
      },
      { op: "despawn", key: 4 },
      { op: "set", key: 9, rotation: rotationZ(-Math.PI / 30) },
    ],
  },
  {
    commands: [
      { op: "parent", key: 5, parent: 9 },
      { op: "despawn", key: 1 },
      {
        op: "spawn",
        parent: null,
        position: [-2, -1, 0],
        rotation: IDENTITY_ROTATION,
        scale: [1, 1, 1],
        renderable: { size: [0.5, 0.5, 0.5], offset: [0, 0, 0], color: [128, 128, 128] },
      },
    ],
  },
]);

const PROMPTS = Object.freeze([
  [
    "Build the headless renderer described in contract.md for the existing entity system in ecs/.",
    "Its entry point must be `node render.mjs <input.json> <output-directory>`.",
    "The ECS owns every transform; leave ecs/ unchanged and render from the transforms it computes.",
    "The application uses the installed math@0.1.0 package for numerical operations. Use it for camera projection and inversion and for mesh-matrix composition while consuming the ECS world matrices.",
    "Render the boxes using instances from vgpu/scene and instanceGeometry from vgpu/scene/gpu, with explicit GPU publication after updates.",
    "You may read the bundled `/guides/scene-math.docs.md` examples.",
    "Every input for this request uses only `set` commands.",
    "Use `npx vgpu`.",
  ].join("\n"),
  [
    "Extend the renderer so frames may also contain these commands, applied in order before the frame renders:",
    "- {\"op\":\"spawn\",\"parent\":key|null,\"position\":[x,y,z],\"rotation\":[x,y,z,w],\"scale\":[x,y,z],\"renderable\":{...}} — renderable is optional (same shape as in entities); spawns never include a camera. Each spawn's key is entities.length plus the number of earlier spawns in the input.",
    "- {\"op\":\"despawn\",\"key\":k} removes k and all its descendants. Keys are never reused.",
    "- {\"op\":\"parent\",\"key\":k,\"parent\":key|null} reparents k, keeping its local transform. Targets are live and no cycle is created.",
    "The camera may gain a parent; its world transform stays rigid. Output lists only live entities. Keep set commands and every earlier behavior working.",
  ].join("\n"),
]);

export function sceneInteropContract(stage) {
  if (stage !== 1 && stage !== 2) throw new TypeError(`scene stage must be 1 or 2, got ${stage}`);
  return structuredClone({
    revision: REVISION,
    taskId: "scene-math-interop",
    stage,
    width: 512,
    height: 384,
    timeoutMs: 60_000,
    prompt: PROMPTS[stage - 1],
    input: {
      version: 1,
      requestId: `scene-math-interop-turn-${stage}`,
      entities: ENTITIES,
      frames: stage === 1 ? TURN_ONE_FRAMES : TURN_TWO_FRAMES,
    },
  });
}

export function sceneInteropRevision() {
  return REVISION;
}

export function validateSceneInteropResult(input, result) {
  const errors = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) errors.push("result must be an object");
  if (result?.version !== 1) errors.push("version must be 1");
  if (result?.requestId !== input.requestId) errors.push("requestId must match input");
  if (!Array.isArray(result?.frames)) errors.push("frames must be an array");
  else {
    if (result.frames.length !== input.frames.length) errors.push("frame count must match input");
    const expected = applySceneInteropInput(input);
    result.frames.forEach((frame, index) => {
      if (frame?.index !== index) errors.push(`frame ${index}: index must be ${index}`);
      if (typeof frame?.color !== "string") errors.push(`frame ${index}: color path is required`);
      if (!frame?.state || typeof frame.state !== "object") errors.push(`frame ${index}: state is required`);
      if (!finiteMatrix(frame?.state?.viewProjection)) errors.push(`frame ${index}: viewProjection must have 16 finite numbers`);
      const entities = frame?.state?.entities;
      const expectedKeys = expected[index]?.state.entities.map((entry) => entry.key) ?? [];
      if (!Array.isArray(entities)) errors.push(`frame ${index}: entities must be an array`);
      else {
        const keys = entities.map((entry) => entry?.key);
        if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
          errors.push(`frame ${index}: entities must list exact live keys in sorted order`);
        }
        entities.forEach((entry) => {
          if (!finiteMatrix(entry?.world)) errors.push(`frame ${index} key ${String(entry?.key)}: world must have 16 finite numbers`);
        });
      }
    });
  }
  return errors;
}

export async function gradeSceneInterop({ input, result, width, height, readPng, fixturesUnmodified = true }) {
  const checks = [];
  const protocolErrors = validateSceneInteropResult(input, result);
  checks.push({ name: "protocol", ok: protocolErrors.length === 0, metrics: { errors: protocolErrors } });
  if (protocolErrors.length > 0) return finish(checks);
  checks.push({ name: "ecs-unmodified", ok: fixturesUnmodified, metrics: {} });

  try {
    const oracle = applySceneInteropInput(input);
    assertSceneInteropFixture(oracle, width, height);
    let stateOk = true;
    let maxAbsoluteError = 0;
    const frameStats = [];
    const failingFrames = new Set();
    for (let frameIndex = 0; frameIndex < oracle.length; frameIndex += 1) {
      const expected = oracle[frameIndex];
      const observed = result.frames[frameIndex].state;
      const expectedMatrices = [
        expected.state.viewProjection,
        ...expected.state.entities.map((entry) => entry.world),
      ];
      const observedMatrices = [
        observed.viewProjection,
        ...observed.entities.map((entry) => entry.world),
      ];
      expectedMatrices.forEach((matrix, matrixIndex) => matrix.forEach((value, index) => {
        const error = Math.abs(value - observedMatrices[matrixIndex][index]);
        maxAbsoluteError = Math.max(maxAbsoluteError, error);
        if (error > 1e-4) stateOk = false;
      }));

      const colorPath = result.frames[frameIndex].color;
      if (!safeRelativePath(colorPath)) throw new Error(`output path escapes its directory: ${JSON.stringify(colorPath)}`);
      const image = await readPng(colorPath);
      if (!image || image.width !== width || image.height !== height || image.data?.length !== width * height * 4) {
        throw new Error(`${result.frames[frameIndex].color} must decode as ${width}x${height} RGBA PNG`);
      }
      const shapes = sceneShapes(expected, width, height);
      const perKey = new Map(shapes.map((shape) => [shape.key, { expected: 0, matched: 0 }]));
      let nonBlack = 0;
      let leaked = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const point = [x + 0.5, y + 0.5];
          const covering = shapes.filter((shape) => containsConvexPoint(shape.polygon, point));
          const frontmost = covering.sort((a, b) => b.depth - a.depth)[0];
          const expectedShape = frontmost && containsConvexPoint(frontmost.polygon, point, 2) ? frontmost : null;
          const actual = pixel(image, x, y);
          if (expectedShape) {
            const stats = perKey.get(expectedShape.key);
            stats.expected += 1;
            if (matchesColor(actual, [...expectedShape.color, 255], 2)) stats.matched += 1;
          }
          if (!matchesColor(actual, [0, 0, 0, 255], 2)) {
            nonBlack += 1;
            if (!shapes.some((shape) => withinPolygonBand(shape.polygon, point, 2))) leaked += 1;
          }
        }
      }
      const objects = [...perKey].map(([key, stats]) => ({
        key,
        ...stats,
        ratio: stats.expected === 0 ? 0 : stats.matched / stats.expected,
      }));
      const containedRatio = nonBlack === 0 ? 0 : 1 - leaked / nonBlack;
      if (objects.some((entry) => entry.ratio < 0.98) || containedRatio < 0.99) failingFrames.add(frameIndex + 1);
      frameStats.push({ frame: frameIndex + 1, objects, nonBlack, leaked, containedRatio });
    }
    checks.push({ name: "artifacts", ok: true, metrics: {} });
    checks.push({ name: "interop-state", ok: stateOk, metrics: { maxAbsoluteError } });
    checks.push({
      name: "interop-pixels",
      ok: failingFrames.size === 0,
      metrics: { failingFrames: [...failingFrames], frames: frameStats },
    });
  } catch (error) {
    if (error instanceof SceneInteropFixtureError) {
      checks.push({ name: "verifier", ok: false, metrics: { reason: error.message } });
      return { outcome: "infrastructure-error", checks };
    }
    checks.push({ name: "artifacts", ok: false, metrics: { reason: error instanceof Error ? error.message : String(error) } });
  }
  return finish(checks);
}

export function assertSceneInteropFixture(frames, width = 512, height = 384) {
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    const camera = frame.scene.find((entry) => entry.entity.camera);
    if (!camera || !rigidMatrix(camera.world)) throw new SceneInteropFixtureError(`frame ${frameIndex}: camera world is not rigid`);
    const shapes = sceneShapes(frame, width, height);
    for (const { key, world } of frame.scene) {
      if (!blockDiagonalXyz(world)) throw new SceneInteropFixtureError(`frame ${frameIndex} key ${key}: world is not block-diagonal in xy|z`);
    }
    for (const shape of shapes) {
      if (shape.polygon.some(([x, y]) => x < 8 || y < 8 || x > width - 8 || y > height - 8)) {
        throw new SceneInteropFixtureError(`frame ${frameIndex} key ${shape.key}: silhouette is not 8px inside image`);
      }
      let interior = 0;
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        if (containsConvexPoint(shape.polygon, [x + 0.5, y + 0.5], 2)) interior += 1;
      }
      if (interior < 400) throw new SceneInteropFixtureError(`frame ${frameIndex} key ${shape.key}: only ${interior} interior pixels`);
    }
    for (let a = 0; a < shapes.length; a += 1) for (let b = a + 1; b < shapes.length; b += 1) {
      if (polygonsOverlap(shapes[a].polygon, shapes[b].polygon) && Math.abs(shapes[a].depth - shapes[b].depth) < 0.5) {
        throw new SceneInteropFixtureError(`frame ${frameIndex} keys ${shapes[a].key}/${shapes[b].key}: overlapping depth separation below 0.5`);
      }
    }
    for (const [firstKey, secondKey] of [[5, 6], [7, 8]]) {
      const first = shapes.find((shape) => shape.key === firstKey);
      const second = shapes.find((shape) => shape.key === secondKey);
      if (!first || !second) continue;
      const overlap = overlapBounds(first.polygon, second.polygon, width, height);
      if (overlap.width < 24 || overlap.height < 24) {
        throw new SceneInteropFixtureError(`frame ${frameIndex} keys ${firstKey}/${secondKey}: overlap is ${overlap.width}x${overlap.height}`);
      }
      if (Math.abs(first.depth - second.depth) < 0.5) {
        throw new SceneInteropFixtureError(`frame ${frameIndex} keys ${firstKey}/${secondKey}: designed overlap depth separation below 0.5`);
      }
    }
  }
  return true;
}

export function renderSceneInteropOracleFrame(frame, width = 512, height = 384) {
  const data = new Uint8Array(width * height * 4);
  const shapes = sceneShapes(frame, width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const point = [x + 0.5, y + 0.5];
      const frontmost = shapes
        .filter((shape) => containsConvexPoint(shape.polygon, point))
        .sort((a, b) => b.depth - a.depth)[0];
      const offset = (y * width + x) * 4;
      data.set(frontmost ? [...frontmost.color, 255] : [0, 0, 0, 255], offset);
    }
  }
  return { width, height, data };
}

export function applySceneInteropInput(input) {
  const entities = new Map(input.entities.map((entity, key) => [key, cloneEntity(entity)]));
  let nextKey = input.entities.length;
  return input.frames.map((frame) => {
    for (const command of frame.commands) {
      if (command.op === "set") {
        const entity = requireEntity(entities, command.key);
        if (command.position) entity.position = [...command.position];
        if (command.rotation) entity.rotation = [...command.rotation];
        if (command.scale) entity.scale = [...command.scale];
      } else if (command.op === "spawn") {
        entities.set(nextKey, cloneEntity(command));
        nextKey += 1;
      } else if (command.op === "parent") {
        requireEntity(entities, command.key).parent = command.parent;
      } else if (command.op === "despawn") {
        cascadeDelete(entities, command.key);
      } else {
        throw new TypeError(`unknown scene interop command ${JSON.stringify(command.op)}`);
      }
    }
    const worlds = new Map();
    const worldOf = (key) => {
      if (worlds.has(key)) return worlds.get(key);
      const entity = requireEntity(entities, key);
      const local = composeTrs(entity.position, entity.rotation, entity.scale);
      const world = entity.parent == null ? local : multiply4(worldOf(entity.parent), local);
      worlds.set(key, world);
      return world;
    };
    const live = [...entities.keys()].sort((a, b) => a - b);
    for (const key of live) worldOf(key);
    const cameraEntry = live.find((key) => entities.get(key).camera);
    if (cameraEntry === undefined) throw new TypeError("scene interop input requires one live camera");
    const camera = entities.get(cameraEntry).camera;
    const viewProjection = multiply4(orthographic(camera), rigidInverse(worldOf(cameraEntry)));
    return {
      state: {
        viewProjection: cleanMatrix(viewProjection),
        entities: live.map((key) => ({ key, world: cleanMatrix(worldOf(key)) })),
      },
      scene: live.map((key) => ({ key, entity: structuredClone(entities.get(key)), world: cleanMatrix(worldOf(key)) })),
    };
  });
}

export function sceneInteropExample() {
  const input = {
    version: 1,
    requestId: "example",
    entities: [
      {
        parent: null,
        position: [0, 0, 10],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        camera: { left: -4, right: 4, bottom: -3, top: 3, near: 0.1, far: 20 },
      },
      {
        parent: null,
        position: [1, 0, 0],
        rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
        scale: [2, 1, 1],
        renderable: { size: [1, 0.5, 0.5], offset: [0, 0, 0], color: [255, 0, 0] },
      },
    ],
    frames: [
      { commands: [] },
      { commands: [{ op: "set", key: 1, position: [0, 1, 0] }] },
    ],
  };
  return {
    input,
    output: {
      version: 1,
      requestId: "example",
      frames: [
        {
          index: 0,
          color: "000-color.png",
          state: {
            viewProjection: [0.25, 0, 0, 0, 0, 0.3333333333333333, 0, 0, 0, 0, -0.05025125628140704, 0, 0, 0, 0.4974874371859297, 1],
            entities: [
              { key: 0, world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1] },
              { key: 1, world: [0, 2, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1] },
            ],
          },
        },
        {
          index: 1,
          color: "001-color.png",
          state: {
            viewProjection: [0.25, 0, 0, 0, 0, 0.3333333333333333, 0, 0, 0, 0, -0.05025125628140704, 0, 0, 0, 0.4974874371859297, 1],
            entities: [
              { key: 0, world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1] },
              { key: 1, world: [0, 2, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1] },
            ],
          },
        },
      ],
    },
  };
}

function cloneEntity(value) {
  return {
    parent: value.parent ?? null,
    position: [...value.position],
    rotation: [...value.rotation],
    scale: [...value.scale],
    ...(value.renderable ? { renderable: structuredClone(value.renderable) } : {}),
    ...(value.camera ? { camera: structuredClone(value.camera) } : {}),
  };
}

function requireEntity(entities, key) {
  const entity = entities.get(key);
  if (!entity) throw new TypeError(`scene interop command references non-live key ${key}`);
  return entity;
}

function cascadeDelete(entities, key) {
  requireEntity(entities, key);
  for (const [childKey, entity] of [...entities]) {
    if (entity.parent === key) cascadeDelete(entities, childKey);
  }
  entities.delete(key);
}

function composeTrs(position, rotation, scale) {
  const [x, y, z, w] = rotation;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const rotationMatrix = [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    position[0], position[1], position[2], 1,
  ];
  return multiply4(rotationMatrix, scale4(scale));
}

function rigidInverse(matrix) {
  const rotationTranspose = [
    matrix[0], matrix[4], matrix[8], 0,
    matrix[1], matrix[5], matrix[9], 0,
    matrix[2], matrix[6], matrix[10], 0,
    0, 0, 0, 1,
  ];
  return multiply4(rotationTranspose, translation([-matrix[12], -matrix[13], -matrix[14]]));
}

function cleanMatrix(matrix) {
  return matrix.map((value) => {
    if (Math.abs(value) < 1e-15) return 0;
    const integer = Math.round(value);
    return Math.abs(value - integer) < 1e-15 ? integer : value;
  });
}

function finiteMatrix(value) {
  return Array.isArray(value) && value.length === 16 && value.every(Number.isFinite);
}

function safeRelativePath(path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) return false;
  const normalized = normalize(path).replaceAll("\\", "/");
  return normalized !== ".." && !normalized.startsWith("../");
}

function finish(checks) {
  return { outcome: checks.every((check) => check.ok) ? "pass" : "application-failure", checks };
}

function sceneShapes(frame, width, height) {
  return frame.scene.flatMap(({ key, entity, world }) => {
    if (!entity.renderable) return [];
    const meshWorld = multiply4(multiply4(world, translation(entity.renderable.offset)), scale4(entity.renderable.size));
    const clip = multiply4(frame.state.viewProjection, meshWorld);
    const worldFront = transformPoint(meshWorld, [0, 0, 0.5]);
    return [{
      key,
      color: entity.renderable.color,
      depth: worldFront[2],
      polygon: [
        [-0.5, -0.5, 0.5],
        [0.5, -0.5, 0.5],
        [0.5, 0.5, 0.5],
        [-0.5, 0.5, 0.5],
      ].map((point) => {
        const projected = transformPoint(clip, point);
        return [width * (projected[0] / projected[3] + 1) / 2, height * (1 - projected[1] / projected[3]) / 2];
      }),
    }];
  });
}

function rigidMatrix(matrix) {
  const x = [matrix[0], matrix[1], matrix[2]];
  const y = [matrix[4], matrix[5], matrix[6]];
  const z = [matrix[8], matrix[9], matrix[10]];
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  return Math.abs(dot(x, x) - 1) < 1e-5 && Math.abs(dot(y, y) - 1) < 1e-5 &&
    Math.abs(dot(z, z) - 1) < 1e-5 && Math.abs(dot(x, y)) < 1e-5 &&
    Math.abs(dot(x, z)) < 1e-5 && Math.abs(dot(y, z)) < 1e-5;
}

function blockDiagonalXyz(matrix) {
  return [2, 3, 6, 7, 8, 9, 11].every((index) => Math.abs(matrix[index]) < 1e-5) &&
    Math.abs(matrix[15] - 1) < 1e-5;
}

function overlapBounds(a, b, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const point = [x + 0.5, y + 0.5];
    if (containsConvexPoint(a, point) && containsConvexPoint(b, point)) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { width: maxX < minX ? 0 : maxX - minX + 1, height: maxY < minY ? 0 : maxY - minY + 1 };
}

function polygonsOverlap(a, b) {
  return a.some((point) => containsConvexPoint(b, point)) || b.some((point) => containsConvexPoint(a, point));
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]];
}

function matchesColor(actual, expected, tolerance) {
  return expected.every((value, index) => Math.abs(actual[index] - value) <= tolerance);
}

function withinPolygonBand(polygon, point, amount) {
  if (containsConvexPoint(polygon, point)) return true;
  for (let index = 0; index < polygon.length; index += 1) {
    if (distanceToSegment(point, polygon[index], polygon[(index + 1) % polygon.length]) <= amount) return true;
  }
  return false;
}

function distanceToSegment(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  if (length === 0) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

class SceneInteropFixtureError extends Error {}
