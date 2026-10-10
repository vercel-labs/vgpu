import compositionShader from "./composition.wgsl";
import {
  draw,
  frame,
  geometry,
  init,
  target,
  type Gpu,
  type Target,
} from "vgpu/node";
import {
  box,
  composeMatrix,
  evaluateHierarchy,
  group,
  hierarchyOrder,
  instances,
  perspective,
  viewMatrices,
  type CameraMatrices,
  type InstanceCollection,
  type InstanceId,
  type Mat4,
} from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";

export type CompositionPath = "groups" | "hierarchy" | "final-worlds";

const WIDTH = 64;
const HEIGHT = 48;
const CAMERA_TARGET = [0, 0, 0] as const;
const CAMERA_UP = [0, 1, 0] as const;
const INITIAL_CAMERA_POSITION = [0, 0, 7] as const;
const INITIAL_ROOT_POSITION = [-1.5, -0.5, 0] as const;
const BASE_SCALE = [0.5, 0.25, 0.5] as const;
const CHILD_POSITION = [3, 2, 0] as const;
const TOOL_SCALE = [1.5, 0.5, 1.25] as const;
const LENS = { fov: 45, near: 0.1, far: 100 } as const;

const ATTRIBUTES = {
  tint: "float32x4",
  pickingId: "uint32",
} as const;

type CompositionInstances = InstanceCollection<typeof ATTRIBUTES>;

export interface CompositionExample {
  readonly path: CompositionPath;
  readonly positionTarget: Target;
  readonly colorTarget: Target;
  readonly matrices: CameraMatrices;
  render(): number;
  moveRoot(position: ArrayLike<number>): number;
  moveCameraWithoutUpload(position: ArrayLike<number>): void;
  uploadCamera(): void;
  resetExternalWorlds(): number;
  updatedRows(): Uint8Array;
  clear(): number;
}

export function createCompositionExample(gpu: Gpu, path: CompositionPath): CompositionExample {
  const collection = instances({ capacity: 3, attributes: ATTRIBUTES });
  const ids = addInstances(collection);
  const pathState = createPathState(path, collection, ids);
  const bridge = instanceGeometry(gpu, collection, {
    mesh: geometry(gpu, box({ size: 0.8 })),
  });

  const positionTarget = target(gpu, {
    size: [WIDTH, HEIGHT],
    format: "rgba32float",
    depth: true,
    label: `${path}.positions`,
  });
  const colorTarget = target(gpu, {
    size: [WIDTH, HEIGHT],
    format: "rgba32float",
    depth: true,
    label: `${path}.colors`,
  });
  const positionPass = draw(gpu, {
    shader: compositionShader,
    geometry: bridge.geometry,
    entry: { vertex: "vs_main", fragment: "fs_position" },
    targets: [positionTarget],
    label: `${path}.position-pass`,
  });
  const colorPass = draw(gpu, {
    shader: compositionShader,
    geometry: bridge.geometry,
    entry: { vertex: "vs_main", fragment: "fs_color" },
    targets: [colorTarget],
    label: `${path}.color-pass`,
  });

  const cameraNode = group({ position: INITIAL_CAMERA_POSITION }).lookAt(CAMERA_TARGET, CAMERA_UP);
  const pose = {
    position: new Float32Array(cameraNode.worldPosition),
    quaternion: new Float32Array(cameraNode.quaternion),
  };
  const projection = perspective(LENS, WIDTH / HEIGHT, new Float32Array(16));
  const matrices = {
    view: new Float32Array(16),
    viewProjection: new Float32Array(16),
  };
  viewMatrices(pose, projection, matrices);

  const uploadCamera = () => {
    positionPass.set({ camera: { viewProjection: matrices.viewProjection } });
    colorPass.set({ camera: { viewProjection: matrices.viewProjection } });
  };
  uploadCamera();

  return {
    path,
    positionTarget,
    colorTarget,
    matrices,
    render(): number {
      pathState.sync();
      // One publication supplies both passes. Passes that need different instance contents
      // should use separate bridges instead of rewriting this buffer between encodes.
      const count = bridge.publish();
      frame(gpu, (currentFrame) => {
        currentFrame.pass(
          { target: positionTarget, clear: [0, 0, 0, 0] },
          (pass) => pass.draw(positionPass, { instances: count }),
        );
        currentFrame.pass(
          { target: colorTarget, clear: [0, 0, 0, 0] },
          (pass) => pass.draw(colorPass, { instances: count }),
        );
      });
      return count;
    },
    moveRoot(position): number {
      return pathState.moveRoot(position);
    },
    moveCameraWithoutUpload(position): void {
      cameraNode.set({ position }).lookAt(CAMERA_TARGET, CAMERA_UP);
      pose.position.set(cameraNode.worldPosition);
      pose.quaternion.set(cameraNode.quaternion);
      viewMatrices(pose, projection, matrices);
    },
    uploadCamera,
    resetExternalWorlds(): number {
      return pathState.resetExternalWorlds();
    },
    updatedRows(): Uint8Array {
      return pathState.updatedRows();
    },
    clear(): number {
      while (collection.count > 0) collection.remove(collection.idAt(collection.count - 1));
      return bridge.publish();
    },
  };
}

export async function runCompositionExample(path: CompositionPath = "groups") {
  const gpu = await init();
  const example = createCompositionExample(gpu, path);
  const count = example.render();
  return { gpu, example, count };
}

interface PathState {
  sync(): number;
  moveRoot(position: ArrayLike<number>): number;
  resetExternalWorlds(): number;
  updatedRows(): Uint8Array;
}

function createPathState(
  path: CompositionPath,
  collection: CompositionInstances,
  ids: readonly InstanceId[],
): PathState {
  if (path === "groups") return createGroupPath(collection, ids);
  if (path === "hierarchy") return createHierarchyPath(collection, ids);
  return createFinalWorldPath(collection, ids);
}

function createGroupPath(collection: CompositionInstances, ids: readonly InstanceId[]): PathState {
  const tool = group({ position: CHILD_POSITION, scale: TOOL_SCALE, label: "tool" });
  const arm = group({ position: CHILD_POSITION, children: [tool], label: "arm" });
  const base = group({
    position: INITIAL_ROOT_POSITION,
    scale: BASE_SCALE,
    children: [arm],
    label: "base",
  });
  const nodes = [base, arm, tool] as const;
  ids.forEach((id, index) => collection.bindWorld(id, () => nodes[index]!.worldMatrix));
  collection.syncWorlds();

  return {
    sync: () => collection.syncWorlds(),
    moveRoot(position): number {
      base.set({ position });
      return collection.syncWorlds();
    },
    resetExternalWorlds: notExternalHierarchy,
    updatedRows: () => new Uint8Array(0),
  };
}

function createHierarchyPath(collection: CompositionInstances, ids: readonly InstanceId[]): PathState {
  const parents = new Int32Array([-1, 0, 1]);
  const order = hierarchyOrder(parents);
  const locals = localMatrices(INITIAL_ROOT_POSITION);
  let worlds = new Float32Array(3 * 16);
  const changed = new Uint8Array(3);
  const updated = new Uint8Array(3);

  const fullEvaluation = () => {
    const count = evaluateHierarchy({ order, parents, locals, worlds, updated });
    collection.setWorlds(ids, worlds);
    return count;
  };
  fullEvaluation();

  return {
    sync: () => 0,
    moveRoot(position): number {
      composeMatrix({ position, scale: BASE_SCALE }, row(locals, 0));
      changed.fill(0);
      changed[0] = 1;
      const count = evaluateHierarchy({ order, parents, locals, worlds, changed, updated });
      collection.setWorlds(ids, worlds);
      return count;
    },
    resetExternalWorlds(): number {
      worlds = new Float32Array(3 * 16);
      return fullEvaluation();
    },
    updatedRows: () => new Uint8Array(updated),
  };
}

function createFinalWorldPath(collection: CompositionInstances, ids: readonly InstanceId[]): PathState {
  const setFinalWorlds = (rootPosition: ArrayLike<number>) => {
    const worlds = finalWorldMatrices(rootPosition);
    collection.setWorlds(ids, worlds);
    return ids.length;
  };
  setFinalWorlds(INITIAL_ROOT_POSITION);

  return {
    sync: () => 0,
    moveRoot: setFinalWorlds,
    resetExternalWorlds: notExternalHierarchy,
    updatedRows: () => new Uint8Array(0),
  };
}

function addInstances(collection: CompositionInstances): readonly InstanceId[] {
  // The returned handles are collection identities. pickingId is separate app data that the
  // second pass can read back or map to an application selection.
  return [
    collection.add({ tint: [1, 0.25, 0.5, 1], pickingId: 303 }),
    collection.add({ tint: [0.5, 1, 0.25, 1], pickingId: 202 }),
    collection.add({ tint: [0.25, 0.5, 1, 1], pickingId: 101 }),
  ];
}

function localMatrices(rootPosition: ArrayLike<number>): Float32Array {
  const locals = new Float32Array(3 * 16);
  composeMatrix({ position: rootPosition, scale: BASE_SCALE }, row(locals, 0));
  composeMatrix({ position: CHILD_POSITION }, row(locals, 1));
  composeMatrix({ position: CHILD_POSITION, scale: TOOL_SCALE }, row(locals, 2));
  return locals;
}

function finalWorldMatrices(rootPosition: ArrayLike<number>): Float32Array {
  const worlds = new Float32Array(3 * 16);
  const rootX = rootPosition[0]!;
  const rootY = rootPosition[1]!;
  const rootZ = rootPosition[2]!;
  composeMatrix({ position: rootPosition, scale: BASE_SCALE }, row(worlds, 0));
  composeMatrix({ position: [rootX + 1.5, rootY + 0.5, rootZ], scale: BASE_SCALE }, row(worlds, 1));
  composeMatrix({
    position: [rootX + 3, rootY + 1, rootZ],
    scale: [BASE_SCALE[0] * TOOL_SCALE[0], BASE_SCALE[1] * TOOL_SCALE[1], BASE_SCALE[2] * TOOL_SCALE[2]],
  }, row(worlds, 2));
  return worlds;
}

function row(matrices: Float32Array, index: number): Mat4 {
  return matrices.subarray(index * 16, (index + 1) * 16) as Mat4;
}

function notExternalHierarchy(): never {
  throw new Error("resetExternalWorlds() is only available for the hierarchy path.");
}
