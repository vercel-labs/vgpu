// GPU side of the training ground, shared by the live renderer and the thumbnail. DOM-free.
//
// Per frame: the rig poses the robots (only when the simulation stepped), publishes their worlds
// into the part collections, each bridge's publish() uploads changed rows and returns its count,
// and the sun shadow and colour passes draw with that same count. Terrain uploads only the vertex
// rows a sculpt touched.

import { vec3, type Quat, type Vec3 } from "math";
import { draw, effect, geometry, sampler, target, uniforms, type Draw, type Frame, type FramePass, type Geometry, type Gpu, type Target } from "vgpu";
import {
  group,
  instances,
  orthographic,
  perspective,
  plane,
  rigPose,
  viewMatrices,
  type CameraMatrices,
  type Lens,
  type OrbitRig,
  type Pose,
} from "vgpu/scene";
import { instanceGeometry, type InstanceGeometry } from "vgpu/scene/gpu";

import { fitLens } from "./camera";
import { MAX_ROBOTS, type Colony } from "./colony";
import debugShader from "./debug.wgsl";
import floorShader from "./floor.wgsl";
import { LEG_COUNT } from "./robot";
import { buildPartMeshes, buildPlinthMesh, MESH_VERTEX_FLOATS, type MeshData } from "./meshes";
import partsShader from "./parts.wgsl";
import presentShader from "./present.wgsl";
import { createRig, PART_ATTRIBUTES, PART_MESHES, poseRig, publishRig, ROWS_PER_ROBOT, type PartCollection, type PartMesh, type Rig } from "./rig";
import shadowShader from "./shadow.wgsl";
import { uploadTerrain, VERTEX_BYTES, type Terrain } from "./terrain";
import terrainShader from "./terrain.wgsl";

export const LENS: Lens = { fov: 35, near: 0.05, far: 100 };
export const SHADOW_SIZE = 2048;
/** Display-encoded clear colour (the neutral gray backdrop); matches backgroundColor(0) in common.wgsl. */
export const CLEAR_COLOR = [0.5, 0.505, 0.51] as const;
const SUN_DIRECTION = normalize([-0.45, 0.8, 0.35]);
const SUN_DISTANCE = 30;
const SUN_HALF_EXTENT = 11.5;
/** Debug segments per robot: hip offset, femur, tibia, a target, a foot and a landing mark per leg, and a heading. */
const SEGMENTS_PER_ROBOT = LEG_COUNT * 6 + 1;
const SEGMENT_FLOATS = 10;
const BODY_CONTACT_RADIUS = 0.3;

/** Brush ring: x, z, radius, mode (0 hidden, 1 elevate, -1 lower, 2 destination aim). */
export type BrushOverlay = [number, number, number, number];

export interface RenderState {
  /** Seconds of wall time (drives the destination pulse; frozen under reduced motion is fine). */
  readonly time: number;
  readonly brush: BrushOverlay;
  readonly debug: boolean;
}

export interface GardenCamera {
  readonly pose: Pose;
  readonly projection: Float32Array;
  readonly matrices: CameraMatrices;
}

export interface UploadCounters {
  /** Instances drawn in the last colour pass (robot parts and the plinth). */
  instances: number;
  /** Running totals since creation: terrain vertex bytes written, and robot part rows re-posed and published. */
  terrainBytes: number;
  rigRows: number;
}

export interface GardenPipeline {
  readonly camera: GardenCamera;
  /** LENS fitted to the current aspect (wider on portrait frames); the pointer ray uses it too. */
  readonly lens: Lens;
  readonly rig: Rig;
  /** Read-only upload counters for the stats panel. */
  readonly counters: UploadCounters;
  resize(size: readonly [number, number], pixelRatio: number): void;
  updateCamera(rig: OrbitRig): void;
  /** Encodes every pass of one frame. */
  render(currentFrame: Frame, output: Target, state: RenderState): void;
}

export function createPipeline(gpu: Gpu, colony: Colony, size: readonly [number, number]): GardenPipeline {
  const rig = createRig(MAX_ROBOTS);
  const partMeshes = buildPartMeshes();

  const partBridges = Object.fromEntries(
    PART_MESHES.map((mesh) => [mesh, instanceGeometry(gpu, rig.collections[mesh], { mesh: meshGeometry(gpu, partMeshes[mesh]) })]),
  ) as Record<PartMesh, InstanceGeometry>;
  // The plinth is one static instance at the origin.
  const plinthCollection: PartCollection = instances({ capacity: 1, attributes: PART_ATTRIBUTES });
  plinthCollection.add();
  const plinthBridge = instanceGeometry(gpu, plinthCollection, { mesh: meshGeometry(gpu, buildPlinthMesh()) });

  const terrain = colony.terrain;
  const terrainGeometry = geometry(gpu, {
    buffers: [
      {
        data: terrain.vertices,
        stride: VERTEX_BYTES,
        attributes: {
          position: { format: "float32x3", offset: 0, location: 0 },
          normal: { format: "float32x3", offset: 12, location: 1 },
          cavity: { format: "float32", offset: 24, location: 2 },
        },
      },
    ],
    indices: terrain.indices,
    label: "garden.terrain",
  });

  const segments = new Float32Array(MAX_ROBOTS * SEGMENTS_PER_ROBOT * SEGMENT_FLOATS);
  const debugGeometry = geometry(gpu, {
    buffers: [
      {
        data: segments,
        stride: SEGMENT_FLOATS * 4,
        stepMode: "instance",
        attributes: {
          a: { format: "float32x3", offset: 0, location: 0 },
          b: { format: "float32x3", offset: 12, location: 1 },
          color: { format: "float32x4", offset: 24, location: 2 },
        },
      },
    ],
    vertexCount: 4,
    topology: "triangle-strip",
    label: "garden.debug",
  });

  const lens: Lens = { ...LENS };
  const camera: GardenCamera = {
    pose: { position: new Float32Array(3), quaternion: new Float32Array(4) },
    projection: new Float32Array(16),
    matrices: { view: new Float32Array(16), viewProjection: new Float32Array(16) },
  };
  const outputSize: [number, number] = [size[0], size[1]];
  const cameraValues = {
    viewProjection: camera.matrices.viewProjection,
    eye: camera.pose.position,
    pixelRatio: 1,
    viewport: [size[0], size[1]],
  };
  const cameraUniforms = uniforms(gpu, cameraValues);

  const contacts = new Float32Array(MAX_ROBOTS * 4);
  const contactViews = Array.from({ length: MAX_ROBOTS }, (_, index) => contacts.subarray(index * 4, index * 4 + 4));
  const sceneValues = {
    lightViewProjection: sunViewProjection(),
    sunDirection: SUN_DIRECTION,
    exposure: 1.05,
    sunColor: [2.7, 2.45, 2.1],
    time: 0,
    skyColor: [0.32, 0.36, 0.42],
    contactCount: 0,
    brush: [0, 0, 1, 0],
    destination: [0, 0, 0, 0],
    contacts: contactViews,
  };
  const sceneUniforms = uniforms(gpu, sceneValues);

  const shadowTarget = target(gpu, { size: [SHADOW_SIZE, SHADOW_SIZE], format: "r8unorm", depth: "depth32float", label: "garden.sun-shadow" });
  const sceneTarget = target(gpu, { size: outputSize, format: "rgba8unorm", depth: true, msaa: true, label: "garden.scene" });
  const shadowSampler = sampler(gpu, {
    compare: "less-equal",
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const linearSampler = sampler(gpu, { minFilter: "linear", magFilter: "linear" });
  const lit = { camera: cameraUniforms, scene: sceneUniforms, shadowMap: shadowTarget, shadowSampler };

  const shadowDraw = (geometryToDraw: Geometry, label: string) =>
    draw(gpu, {
      shader: shadowShader,
      geometry: geometryToDraw,
      targets: [shadowTarget],
      writeMask: [],
      depth: { bias: 2, biasSlopeScale: 2.5 },
      cull: "back",
      set: { scene: sceneUniforms },
      label: `garden.shadow.${label}`,
    });
  const colorDraw = (geometryToDraw: Geometry, label: string) =>
    draw(gpu, { shader: partsShader, geometry: geometryToDraw, targets: [sceneTarget], cull: "back", set: lit, label: `garden.${label}` });

  // Instanced passes in drawing order: [bridge, shadow draw, colour draw].
  const instanced: [InstanceGeometry, Draw, Draw][] = [
    ...PART_MESHES.map((mesh): [InstanceGeometry, Draw, Draw] => [partBridges[mesh], shadowDraw(partBridges[mesh].geometry, mesh), colorDraw(partBridges[mesh].geometry, mesh)]),
    [plinthBridge, shadowDraw(plinthBridge.geometry, "plinth"), colorDraw(plinthBridge.geometry, "plinth")],
  ];
  const terrainShadow = draw(gpu, {
    shader: shadowShader,
    geometry: terrainGeometry,
    entry: { vertex: "vs_terrain", fragment: "fs_main" },
    targets: [shadowTarget],
    writeMask: [],
    depth: { bias: 2, biasSlopeScale: 2.5 },
    cull: "back",
    set: { scene: sceneUniforms },
    label: "garden.shadow.terrain",
  });
  const terrainDraw = draw(gpu, { shader: terrainShader, geometry: terrainGeometry, targets: [sceneTarget], cull: "back", set: lit, label: "garden.terrain" });
  const floorDraw = draw(gpu, {
    shader: floorShader,
    geometry: geometry(gpu, plane({ width: 90, height: 90 })),
    targets: [sceneTarget],
    set: lit,
    label: "garden.floor",
  });
  const debugDraw = draw(gpu, {
    shader: debugShader,
    geometry: debugGeometry,
    targets: [sceneTarget],
    depth: { write: false, compare: "always" },
    blend: "alpha",
    cull: "none",
    set: { camera: cameraUniforms },
    label: "garden.debug",
  });
  const presentValues = { resolution: [outputSize[0], outputSize[1]] };
  const present = effect(gpu, presentShader, { set: { present: presentValues, sceneColor: sceneTarget, linearSampler }, label: "garden.present" });

  // Change tracking: what was last posed, uploaded and published.
  let posedSteps = -1;
  let posedCount = -1;
  let posedSeed = Number.NaN;
  const uploaded = { generation: terrain.generation };
  const counters: UploadCounters = { instances: 0, terrainBytes: 0, rigRows: 0 };
  let destinationRevision = -1;
  let destinationSince = 0;

  function syncRobots(): void {
    if (colony.steps === posedSteps && colony.count === posedCount && colony.seed === posedSeed) return;
    posedSteps = colony.steps;
    posedCount = colony.count;
    posedSeed = colony.seed;
    poseRig(rig, colony.robots, colony.count);
    publishRig(rig, colony.robots, colony.count);
    counters.rigRows += colony.count * ROWS_PER_ROBOT;
  }

  function syncTerrain(): void {
    counters.terrainBytes += uploadTerrain(terrain, terrainGeometry, uploaded);
  }

  function syncContacts(): number {
    for (let index = 0; index < colony.count; index++) {
      const robot = colony.robots[index]!;
      contacts[index * 4] = robot.position[0];
      contacts[index * 4 + 1] = robot.position[1];
      contacts[index * 4 + 2] = robot.position[2];
      contacts[index * 4 + 3] = BODY_CONTACT_RADIUS;
    }
    return colony.count;
  }

  function drawInstanced(pass: FramePass, counts: readonly number[], shadow: boolean): void {
    instanced.forEach(([, shadowPass, colorPass], index) => {
      const count = counts[index]!;
      // A zero-instance draw is a no-op; skipping it keeps an empty collection valid.
      if (count > 0) pass.draw(shadow ? shadowPass : colorPass, { instances: count });
    });
  }

  return {
    camera,
    lens,
    rig,
    counters,
    resize(next, ratio) {
      outputSize[0] = next[0];
      outputSize[1] = next[1];
      sceneTarget.resize(outputSize);
      cameraValues.pixelRatio = ratio;
      cameraValues.viewport = [next[0], next[1]];
      presentValues.resolution = [next[0], next[1]];
      present.set({ present: presentValues });
    },
    updateCamera(orbit) {
      rigPose(orbit, camera.pose);
      const aspect = outputSize[0] / outputSize[1];
      perspective(fitLens(LENS, aspect, lens), aspect, camera.projection);
      viewMatrices(camera.pose, camera.projection, camera.matrices);
      cameraUniforms.set(cameraValues);
    },
    render(currentFrame, output, state) {
      syncRobots();
      syncTerrain();
      const counts = instanced.map(([bridge]) => bridge.publish());
      counters.instances = counts.reduce((sum, count) => sum + count, 0);
      const destination = colony.destination;
      if (destination.revision !== destinationRevision) {
        destinationRevision = destination.revision;
        destinationSince = state.time;
      }
      sceneValues.time = state.time;
      sceneValues.brush = state.brush;
      sceneValues.destination = [destination.x, destination.z, destination.active ? 1 : 0, state.time - destinationSince];
      sceneValues.contactCount = syncContacts();
      sceneUniforms.set(sceneValues);

      // Robots move every step, so the sun shadow re-renders every frame.
      currentFrame.pass({ target: shadowTarget, clear: [0, 0, 0, 0] }, (pass) => {
        pass.draw(terrainShadow);
        drawInstanced(pass, counts, true);
      });
      const debugCount = state.debug ? writeSegments(segments, colony) : 0;
      if (debugCount > 0) debugGeometry.write(segments.subarray(0, debugCount * SEGMENT_FLOATS));
      currentFrame.pass({ target: sceneTarget, clear: [...CLEAR_COLOR, 1] }, (pass) => {
        pass.draw(floorDraw);
        pass.draw(terrainDraw);
        drawInstanced(pass, counts, false);
        if (debugCount > 0) pass.draw(debugDraw, { instances: debugCount });
      });
      currentFrame.pass(output, present);
    },
  };
}

function meshGeometry(gpu: Gpu, mesh: MeshData): Geometry {
  return geometry(gpu, {
    buffers: [
      {
        data: mesh.vertices,
        stride: MESH_VERTEX_FLOATS * 4,
        attributes: {
          position: { format: "float32x3", offset: 0, location: 0 },
          normal: { format: "float32x3", offset: 12, location: 1 },
          material: { format: "float32", offset: 24, location: 2 },
        },
      },
    ],
    indices: mesh.indices,
  });
}

// Debug colours (display sRGB) and widths in CSS px.
const DEBUG = {
  hip: [0.95, 0.95, 0.95, 4.5],
  femur: [1, 0.85, 0.15, 5],
  tibia: [0.2, 0.85, 1, 4.5],
  target: [1, 0.25, 0.85, 7],
  planted: [0.3, 1, 0.35, 8],
  lifted: [0.55, 0.55, 0.55, 6],
  landing: [1, 0.55, 0.1, 7],
  heading: [1, 0.2, 0.15, 3],
} as const;

const worldA: Vec3 = [0, 0, 0];
const worldB: Vec3 = [0, 0, 0];

function bodyPoint(out: Vec3, position: Vec3, rotation: Quat, local: Vec3): Vec3 {
  vec3.transformQuat(out, local, rotation);
  return vec3.add(out, out, position);
}

/** IK chains, targets and footholds of every robot as screen-space segments; returns the count. */
export function writeSegments(out: Float32Array, colony: Colony): number {
  let count = 0;
  const push = (a: Vec3, b: Vec3, style: readonly number[]) => {
    const o = count * SEGMENT_FLOATS;
    out[o] = a[0];
    out[o + 1] = a[1];
    out[o + 2] = a[2];
    out[o + 3] = b[0];
    out[o + 4] = b[1];
    out[o + 5] = b[2];
    out[o + 6] = style[0]!;
    out[o + 7] = style[1]!;
    out[o + 8] = style[2]!;
    out[o + 9] = style[3]!;
    count++;
  };
  const scratch: Vec3 = [0, 0, 0];
  for (let index = 0; index < colony.count; index++) {
    const robot = colony.robots[index]!;
    for (let leg = 0; leg < LEG_COUNT; leg++) {
      const l = robot.legs[leg]!;
      const foot = robot.feet[leg]!;
      bodyPoint(worldA, robot.position, robot.rotation, l.spec.hip);
      bodyPoint(worldB, robot.position, robot.rotation, l.femurBase);
      push(worldA, worldB, DEBUG.hip);
      bodyPoint(worldA, robot.position, robot.rotation, l.knee);
      push(worldB, worldA, DEBUG.femur);
      bodyPoint(worldB, robot.position, robot.rotation, l.foot);
      push(worldA, worldB, DEBUG.tibia);
      bodyPoint(scratch, robot.position, robot.rotation, robot.targets[leg]!);
      push(scratch, scratch, DEBUG.target);
      push(foot.position, foot.position, foot.planted ? DEBUG.planted : DEBUG.lifted);
      push(foot.landing, foot.landing, foot.planted ? DEBUG.planted : DEBUG.landing);
    }
    vec3.set(scratch, 0, 0.14, 0.62);
    bodyPoint(worldA, robot.position, robot.rotation, scratch);
    vec3.set(scratch, 0, 0.14, 0.3);
    bodyPoint(worldB, robot.position, robot.rotation, scratch);
    push(worldB, worldA, DEBUG.heading);
  }
  return count;
}

/** Orthographic sun camera framing the whole tile and plinth. */
function sunViewProjection(): Float32Array {
  const node = group({
    position: [SUN_DIRECTION[0] * SUN_DISTANCE, SUN_DIRECTION[1] * SUN_DISTANCE, SUN_DIRECTION[2] * SUN_DISTANCE],
  }).lookAt([0, 0, 0]);
  const pose: Pose = { position: new Float32Array(node.worldPosition), quaternion: new Float32Array(node.quaternion) };
  const projection = orthographic(
    { left: -SUN_HALF_EXTENT, right: SUN_HALF_EXTENT, bottom: -SUN_HALF_EXTENT, top: SUN_HALF_EXTENT, near: SUN_DISTANCE - 16, far: SUN_DISTANCE + 16 },
    new Float32Array(16),
  );
  const matrices: CameraMatrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
  viewMatrices(pose, projection, matrices);
  return matrices.viewProjection;
}

function normalize(vector: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(...vector);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
