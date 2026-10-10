// The robot dogs as one packed transform hierarchy, plus the instance collections that publish it.
// Rows are grouped by mesh (all shells, all payloads, then every right/left hip, right/left femur,
// tibia and foot), so each mesh's rows form one contiguous run for setWorlds. Within a mesh, rows are
// robot-major. Only the shell row carries the body transform; every other local is relative to its
// parent, so the body root is applied exactly once.
//
// Per leg: the hip row is the abduction roll about the body's +Z at the hip pivot; the femur row
// sits HIP_OFFSET along the rolled X axis and pitches about it; tibia and foot follow at the bone
// lengths. Every joint below the hip is a pure rotation about its local X.
//
// Data flow per rendered frame: simulation state → locals (poseRig) → evaluateHierarchy → worlds →
// setWorlds (publishRig) → the GPU bridges publish.

import { mat4, quat, vec3, type Mat4, type Quat, type Vec3 } from "math";
import { evaluateHierarchy, hierarchyOrder, instances, type HierarchyOrder, type InstanceCollection, type InstanceId } from "vgpu/scene";

import { FEMUR, HIP_OFFSET, legRotations, TIBIA } from "./leg";
import { LEG_COUNT, LEG_SPECS, type Robot } from "./robot";

export const PART_MESHES = ["shell", "payload", "hipRight", "hipLeft", "femurRight", "femurLeft", "tibia", "foot"] as const;
export type PartMesh = (typeof PART_MESHES)[number];
/**
 * Right legs are 0 and 1, left legs 2 and 3 (see LEG_SPECS). Hips and femurs have a mesh per side
 * (the yellow cover faces outward; the left meshes are mirrored geometry, never mirrored frames).
 */
const RIGHT_LEGS = LEG_SPECS.filter((spec) => spec.side === 1).length;
const LEFT_LEGS = LEG_COUNT - RIGHT_LEGS;
/** Rows of each mesh per robot. */
export const PER_ROBOT: Readonly<Record<PartMesh, number>> = {
  shell: 1,
  payload: 1,
  hipRight: RIGHT_LEGS,
  hipLeft: LEFT_LEGS,
  femurRight: RIGHT_LEGS,
  femurLeft: LEFT_LEGS,
  tibia: LEG_COUNT,
  foot: LEG_COUNT,
};
export const ROWS_PER_ROBOT = PART_MESHES.reduce((sum, mesh) => sum + PER_ROBOT[mesh], 0);

/** Payload mount on the chassis top, body space. */
export const PAYLOAD_OFFSET: Vec3 = [0, 0.086, -0.04];

/** Per-instance style: x variant (1 carries the payload), y glow (status LED), z part, w unused. */
export const PART_ATTRIBUTES = { style: { format: "float32x4", default: [0, 0, 0, 0] } } as const;
export type PartCollection = InstanceCollection<typeof PART_ATTRIBUTES>;

export interface LegRows {
  readonly hip: PartMesh;
  readonly femur: PartMesh;
  /** Index among the legs of this side. */
  readonly part: number;
}

const RIGHT_ROWS = { hip: "hipRight", femur: "femurRight" } as const;
const LEFT_ROWS = { hip: "hipLeft", femur: "femurLeft" } as const;

/** Side meshes and part index of a leg's hip and femur rows. */
export function legRows(leg: number): LegRows {
  return LEG_SPECS[leg]!.side === 1 ? { ...RIGHT_ROWS, part: leg } : { ...LEFT_ROWS, part: leg - RIGHT_LEGS };
}

const LEG_ROWS: readonly LegRows[] = LEG_SPECS.map((_, leg) => legRows(leg));

export interface Rig {
  readonly capacity: number;
  readonly order: HierarchyOrder;
  readonly parents: Int32Array;
  readonly locals: Float32Array;
  readonly worlds: Float32Array;
  /** First row of each mesh's run. */
  readonly base: Readonly<Record<PartMesh, number>>;
  readonly collections: Readonly<Record<PartMesh, PartCollection>>;
  /** Live instance handles per mesh, in slot order (robot-major; payloads only for carriers). */
  readonly ids: Readonly<Record<PartMesh, InstanceId[]>>;
  /** Robot index of each live payload instance. */
  readonly payloadRobots: number[];
  /** Robots currently published. */
  count: number;
  /** Robot poses skipped because a local came out non-finite (the previous pose stays). */
  skipped: number;
  /** Last variant written per robot (−1 = none). */
  readonly styles: Float32Array;
}

export function rowOf(rig: Rig, mesh: PartMesh, robot: number, part = 0): number {
  return rig.base[mesh] + robot * PER_ROBOT[mesh] + part;
}

/** Whether a robot carries the sensor payload. */
export function carriesPayload(robot: Robot): boolean {
  return robot.palette === 1;
}

export function createRig(capacity: number): Rig {
  const base = {} as Record<PartMesh, number>;
  let next = 0;
  for (const mesh of PART_MESHES) {
    base[mesh] = next;
    next += capacity * PER_ROBOT[mesh];
  }
  const rows = next;
  const parents = new Int32Array(rows);
  const row = (mesh: PartMesh, robot: number, part = 0) => base[mesh] + robot * PER_ROBOT[mesh] + part;
  for (let robot = 0; robot < capacity; robot++) {
    parents[row("shell", robot)] = -1;
    parents[row("payload", robot)] = row("shell", robot);
    for (let leg = 0; leg < LEG_COUNT; leg++) {
      const rows = LEG_ROWS[leg]!;
      parents[row(rows.hip, robot, rows.part)] = row("shell", robot);
      parents[row(rows.femur, robot, rows.part)] = row(rows.hip, robot, rows.part);
      parents[row("tibia", robot, leg)] = row(rows.femur, robot, rows.part);
      parents[row("foot", robot, leg)] = row("tibia", robot, leg);
    }
  }
  const locals = new Float32Array(rows * 16);
  for (let r = 0; r < rows; r++) locals.set(IDENTITY, r * 16);
  const collections = {} as Record<PartMesh, PartCollection>;
  const ids = {} as Record<PartMesh, InstanceId[]>;
  for (const mesh of PART_MESHES) {
    collections[mesh] = instances({ capacity: capacity * PER_ROBOT[mesh], attributes: PART_ATTRIBUTES });
    ids[mesh] = [];
  }
  const rig: Rig = {
    capacity,
    order: hierarchyOrder(parents),
    parents,
    locals,
    worlds: new Float32Array(rows * 16),
    base,
    collections,
    ids,
    payloadRobots: [],
    count: 0,
    skipped: 0,
    styles: new Float32Array(capacity).fill(-1),
  };
  evaluateHierarchy({ order: rig.order, parents, locals, worlds: rig.worlds });
  return rig;
}

const IDENTITY: Mat4 = mat4.create();
const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
const staging = new Float32Array(ROWS_PER_ROBOT * 16);
const scratch: Mat4 = mat4.create();
const qHip: Quat = [0, 0, 0, 1];
const qFemur: Quat = [0, 0, 0, 1];
const qTibia: Quat = [0, 0, 0, 1];
const qInverse: Quat = [0, 0, 0, 1];
const qRelative: Quat = [0, 0, 0, 1];
const offset: Vec3 = [0, 0, 0];
const ROW_OFFSETS = (() => {
  // Staging slot of each part within one robot.
  const offsets = {} as Record<PartMesh, number>;
  let next = 0;
  for (const mesh of PART_MESHES) {
    offsets[mesh] = next;
    next += PER_ROBOT[mesh];
  }
  return offsets;
})();

function stage(slot: number, rotation: Quat, translation: Vec3): void {
  mat4.fromRotationTranslation(scratch, rotation, translation);
  staging.set(scratch, slot * 16);
}

/** Locals of one robot into the staging block; false when any value is non-finite. */
function stageRobot(robot: Robot): boolean {
  stage(ROW_OFFSETS.shell, robot.rotation, robot.position);
  stage(ROW_OFFSETS.payload, IDENTITY_QUAT, PAYLOAD_OFFSET);
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    const l = robot.legs[leg]!;
    const rows = LEG_ROWS[leg]!;
    legRotations(l, qHip, qFemur, qTibia);
    stage(ROW_OFFSETS[rows.hip] + rows.part, qHip, l.spec.hip);
    quat.multiply(qRelative, quat.invert(qInverse, qHip), qFemur);
    vec3.set(offset, l.spec.side * HIP_OFFSET, 0, 0);
    stage(ROW_OFFSETS[rows.femur] + rows.part, qRelative, offset);
    quat.multiply(qRelative, quat.invert(qInverse, qFemur), qTibia);
    vec3.set(offset, 0, FEMUR, 0);
    stage(ROW_OFFSETS.tibia + leg, qRelative, offset);
    vec3.set(offset, 0, TIBIA, 0);
    stage(ROW_OFFSETS.foot + leg, IDENTITY_QUAT, offset);
  }
  for (let k = 0; k < staging.length; k++) if (!Number.isFinite(staging[k]!)) return false;
  return true;
}

/** Write the locals of the first `count` robots and evaluate the hierarchy. */
export function poseRig(rig: Rig, robots: readonly Robot[], count: number): void {
  for (let index = 0; index < count; index++) {
    if (!stageRobot(robots[index]!)) {
      rig.skipped++;
      continue;
    }
    for (const mesh of PART_MESHES) {
      for (let part = 0; part < PER_ROBOT[mesh]; part++) {
        const from = (ROW_OFFSETS[mesh] + part) * 16;
        rig.locals.set(staging.subarray(from, from + 16), rowOf(rig, mesh, index, part) * 16);
      }
    }
  }
  evaluateHierarchy({ order: rig.order, parents: rig.parents, locals: rig.locals, worlds: rig.worlds });
}

const style: [number, number, number, number] = [0, 0, 0, 0];

/**
 * Match the instance populations to `count` robots (adding or releasing tail handles, so earlier
 * slots never move), refresh styles that changed, and copy the posed worlds into the collections.
 * Payload instances exist only for carriers, so their worlds are copied one row at a time.
 */
export function publishRig(rig: Rig, robots: readonly Robot[], count: number): void {
  for (const mesh of PART_MESHES) {
    if (mesh === "payload") continue;
    const collection = rig.collections[mesh];
    const ids = rig.ids[mesh];
    const wanted = count * PER_ROBOT[mesh];
    while (ids.length > wanted) collection.remove(ids.pop()!);
    while (ids.length < wanted) {
      style[2] = ids.length % PER_ROBOT[mesh];
      ids.push(collection.add({ style }));
    }
  }
  if (count < rig.count) rig.styles.fill(-1, count);
  rig.count = count;
  for (let index = 0; index < count; index++) {
    const robot = robots[index]!;
    const variant = carriesPayload(robot) ? 1 : 0;
    if (rig.styles[index] === variant) continue;
    rig.styles[index] = variant;
    style[0] = variant;
    // The status LED on the sensor face glows on payload carriers.
    style[1] = variant;
    for (const mesh of PART_MESHES) {
      if (mesh === "payload") continue;
      for (let part = 0; part < PER_ROBOT[mesh]; part++) {
        style[2] = part;
        rig.collections[mesh].set(rig.ids[mesh][index * PER_ROBOT[mesh] + part]!, { style });
      }
    }
  }
  publishPayloads(rig, robots, count);
  for (const mesh of PART_MESHES) {
    if (mesh === "payload") continue;
    if (rig.ids[mesh].length > 0) rig.collections[mesh].setWorlds(rig.ids[mesh], rig.worlds, rig.base[mesh]);
  }
}

function publishPayloads(rig: Rig, robots: readonly Robot[], count: number): void {
  const collection = rig.collections.payload;
  const ids = rig.ids.payload;
  const carriers = rig.payloadRobots;
  let live = 0;
  for (let index = 0; index < count; index++) {
    if (!carriesPayload(robots[index]!)) continue;
    if (live === ids.length) {
      style[0] = 1;
      style[1] = 1;
      style[2] = 0;
      ids.push(collection.add({ style }));
    }
    carriers[live] = index;
    const row = rowOf(rig, "payload", index);
    collection.setWorld(ids[live]!, rig.worlds.subarray(row * 16, row * 16 + 16));
    live++;
  }
  while (ids.length > live) collection.remove(ids.pop()!);
  carriers.length = live;
}

/** World translation of a row (float32 storage). */
export function rowPosition(out: Vec3, rig: Rig, row: number): Vec3 {
  out[0] = rig.worlds[row * 16 + 12]!;
  out[1] = rig.worlds[row * 16 + 13]!;
  out[2] = rig.worlds[row * 16 + 14]!;
  return out;
}
