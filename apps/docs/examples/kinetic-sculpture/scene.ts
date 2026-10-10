import { group, instances, srgb, type InstanceCollection, type InstanceId, type SceneNode } from 'vgpu/scene';

/**
 * The mobile as a real vgpu/scene hierarchy, with no GPU or DOM code.
 *
 *   anchor → root (yaw: root angle + sway) → arm → arm → … → pendant → outer ring → inner ring
 *
 * Every group node owns a local transform only. Visible parts are leaf "shape" nodes under those
 * groups; they carry the nonuniform scales (rods, wires, discs, ellipsoids), so a scale never shears
 * a descendant. Each shape is one instance whose world matrix is bound to its node.
 */

export const MIN_LEVELS = 2;
export const MAX_LEVELS = 5;
export const DEFAULT_LEVELS = 4;

export const MESHES = ['box', 'cylinder', 'sphere', 'torus'] as const;
export type MeshName = (typeof MESHES)[number];

/** Per-instance material data. `finish` is [roughness, metallic]. */
export const INSTANCE_ATTRIBUTES = {
  tint: 'float32x3',
  finish: 'float32x2',
} as const;
export type SculptureInstances = InstanceCollection<typeof INSTANCE_ATTRIBUTES>;
export type Collections = Record<MeshName, SculptureInstances>;

interface Material {
  readonly tint: readonly [number, number, number];
  readonly finish: readonly [number, number];
}

const material = (hex: string, roughness: number, metallic: number): Material => ({
  tint: srgb(hex),
  finish: [roughness, metallic],
});

export const MATERIALS = {
  brass: material('#d9a95c', 0.3, 1),
  bronze: material('#5a3f26', 0.45, 1),
  coral: material('#e0644c', 0.62, 0),
  teal: material('#2c8c88', 0.58, 0),
  ivory: material('#eee4cf', 0.66, 0),
  plinth: material('#b4ab9c', 0.88, 0),
} as const;

/** World layout, in metres. The floor is y = 0. */
export const PLINTH = { width: 2.5, depth: 2.5, height: 0.6 } as const;
const CLEARANCE = 0.42;
const TOP_SPAN = 2.7;
const SPAN_RATIO = 0.61;
/** Pendant radius relative to the lowest arm's span, capped so shallow mobiles stay delicate. */
const LEAF_SCALE = 0.3;
const LEAF_MAX_RADIUS = 0.24;
const ROD_RADIUS = 0.02;
const WIRE_RADIUS = 0.0055;
const BEAD_RADIUS = 0.026;
const SUSPENSION_LENGTH = 8;

/** Deterministic per-node values; the same seed always builds the same mobile. */
function hash(value: number): number {
  let x = (value | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

type LeafKind = 'sphere' | 'disc' | 'ellipsoid' | 'gimbal';
const LEAF_KINDS: readonly LeafKind[] = ['disc', 'sphere', 'gimbal', 'ellipsoid', 'sphere', 'disc', 'ellipsoid', 'gimbal'];
const LEAF_COLORS = ['coral', 'teal', 'ivory', 'teal', 'coral', 'ivory', 'coral', 'teal'] as const;

/** Animated groups: every local rotation is a closed-form function of time, never integrated. */
interface Swinging {
  readonly node: SceneNode;
  /** Resting yaw, so sibling sub-mobiles do not all line up. */
  readonly yaw: number;
  /** Yaw swing amplitude (radians at swing = 1). */
  readonly amplitude: number;
  /** Small see-saw roll about the rod's normal (radians at swing = 1). */
  readonly roll: number;
  readonly frequency: number;
  readonly phase: number;
}

interface Spinning {
  readonly node: SceneNode;
  readonly axis: 0 | 1;
  /** Radians per second of animation time. */
  readonly rate: number;
  readonly phase: number;
}

export interface Mobile {
  readonly levels: number;
  /** World-space anchor where the suspension wire meets the root group. */
  readonly anchor: SceneNode;
  readonly root: SceneNode;
  /** Arm groups in build order: arms[0] is the top arm, a direct child of root. */
  readonly arms: readonly SceneNode[];
  readonly leaves: readonly SceneNode[];
  /** Instances created by this build, per mesh, so a rebuild removes exactly these. */
  readonly ids: Record<MeshName, InstanceId[]>;
  /** Bounding sphere of the mobile and plinth at rest, used to fit the camera. */
  readonly center: readonly [number, number, number];
  readonly radius: number;
  /** Half width (horizontal reach) and half height of the framed box around `center`. */
  readonly extent: readonly [number, number];
  readonly swinging: readonly Swinging[];
  readonly spinning: readonly Spinning[];
}

export interface PoseInput {
  /** Animation time in seconds; only advanced while playing. */
  readonly time: number;
  /** Swing amplitude multiplier, 0..1.5. */
  readonly swing: number;
  /** Manual root yaw in radians; propagates to every descendant. */
  readonly rootAngle: number;
}

/** Receives every visible part. The real sink binds instances; the counting sink sizes capacity. */
interface ShapeSink {
  add(mesh: MeshName, node: SceneNode, part: Material): void;
}

interface Subtree {
  readonly mass: number;
  /** Lowest point below the subtree's hang point (positive, metres). */
  readonly depth: number;
  /** Horizontal reach from the hang point. */
  readonly reach: number;
}

function shape(
  sink: ShapeSink,
  parent: SceneNode,
  mesh: MeshName,
  part: Material,
  transform: { position?: readonly number[]; rotation?: readonly number[]; scale: number | readonly number[] },
): SceneNode {
  const node = group({ ...transform, label: mesh });
  parent.add(node);
  sink.add(mesh, node, part);
  return node;
}

interface BuildState {
  readonly sink: ShapeSink;
  readonly arms: SceneNode[];
  readonly leaves: SceneNode[];
  readonly swinging: Swinging[];
  readonly spinning: Spinning[];
  leafIndex: number;
  nodeIndex: number;
}

/** A pendant hanging from its hang point; returns its mass and extent. */
function buildLeaf(state: BuildState, parent: SceneNode, position: readonly number[], size: number): Subtree {
  const index = state.leafIndex++;
  const seed = state.nodeIndex++;
  const kind = LEAF_KINDS[index % LEAF_KINDS.length]!;
  const color = MATERIALS[LEAF_COLORS[(index * 3 + (index >> 3)) % LEAF_COLORS.length]!];
  const radius = size * (0.78 + 0.44 * hash(seed * 7 + 1));
  const leaf = group({ position, label: `leaf-${index}` });
  parent.add(leaf);
  state.leaves.push(leaf);
  const spin = (node: SceneNode, axis: 0 | 1, rate: number) =>
    state.spinning.push({ node, axis, rate, phase: hash(seed * 13 + axis) * Math.PI * 2 });

  let mass: number;
  let depth: number;
  if (kind === 'disc') {
    // A vertical disc: a unit cylinder flattened along its axis, then stood up.
    shape(state.sink, leaf, 'cylinder', color, {
      position: [0, -radius, 0],
      rotation: [Math.PI / 2, 0, 0],
      scale: [radius, 0.035, radius],
    });
    state.swinging.push({
      node: leaf,
      yaw: (hash(seed * 5) - 0.5) * Math.PI,
      amplitude: 0.9,
      roll: 0,
      frequency: 0.41 + 0.2 * hash(seed * 19),
      phase: hash(seed * 41) * Math.PI * 2,
    });
    mass = radius * radius * 0.35;
    depth = radius * 2;
  } else if (kind === 'ellipsoid') {
    const height = radius * 1.35;
    shape(state.sink, leaf, 'sphere', color, {
      position: [0, -height, 0],
      scale: [radius * 0.62, height, radius * 0.62],
    });
    mass = radius ** 3 * 0.75;
    depth = height * 2;
  } else if (kind === 'gimbal') {
    // Two nested rings, each a group that spins about its own axis inside the one above it.
    const outerRadius = radius * 1.05;
    const outer = group({ position: [0, -outerRadius, 0], label: `outer-ring-${index}` });
    const inner = group({ label: `inner-ring-${index}` });
    leaf.add(outer);
    outer.add(inner);
    shape(state.sink, outer, 'torus', MATERIALS.brass, { rotation: [Math.PI / 2, 0, 0], scale: outerRadius });
    shape(state.sink, inner, 'torus', MATERIALS.ivory, { scale: outerRadius * 0.74 });
    shape(state.sink, inner, 'sphere', color, { scale: outerRadius * 0.34 });
    spin(outer, 1, 0.35 + 0.25 * hash(seed * 3));
    spin(inner, 0, 0.55 + 0.3 * hash(seed * 11));
    mass = radius ** 3 * 0.6;
    depth = outerRadius * 2;
  } else {
    shape(state.sink, leaf, 'sphere', color, { position: [0, -radius, 0], scale: radius });
    mass = radius ** 3;
    depth = radius * 2;
  }
  return { mass, depth, reach: radius };
}

/**
 * One balanced arm and everything below it. Its pivot sits at the torque balance
 * (a · M_left = b · M_right), so the arm would hang level if it were a real mobile.
 */
function buildArm(
  state: BuildState,
  parent: SceneNode,
  position: readonly number[],
  level: number,
  levels: number,
  /** -1 for a left child, 1 for a right child, 0 for the top arm. */
  hand: -1 | 0 | 1,
): Subtree {
  const seed = state.nodeIndex++;
  const span = TOP_SPAN * SPAN_RATIO ** level;
  const arm = group({ position, label: `arm-${level}` });
  parent.add(arm);
  state.arms.push(arm);

  // One side hangs clearly lower than the other: sibling subtrees then sit in different height
  // bands and rarely swing through each other.
  const low = hash(seed * 17) < 0.5 ? 0 : 1;
  const drops = [0, 1].map((side) => span * (side === low ? 0.6 : 0.28) * (0.92 + 0.16 * hash(seed * 19 + side)));
  const isLast = level === levels - 1;
  // Children are built at a provisional x and moved once the balance point is known.
  const children = [0, 1].map((side) => {
    const hang = [side === 0 ? -span / 2 : span / 2, -drops[side]!, 0];
    return isLast
      ? buildLeaf(state, arm, hang, Math.min(span * LEAF_SCALE, LEAF_MAX_RADIUS))
      : buildArm(state, arm, hang, level + 1, levels, side === 0 ? -1 : 1);
  });
  const [left, right] = children as [Subtree, Subtree];
  const a = (span * right.mass) / (left.mass + right.mass);
  const b = span - a;
  const ends = [-a, b] as const;
  const childNodes = arm.children.slice(0, 2);
  childNodes.forEach((node, side) => node.set({ position: [ends[side]!, -drops[side]!, 0] }));

  // Rod along local x, built from a unit cylinder laid on its side.
  shape(state.sink, arm, 'cylinder', MATERIALS.brass, {
    position: [(b - a) / 2, 0, 0],
    rotation: [0, 0, Math.PI / 2],
    scale: [ROD_RADIUS * (1 - 0.12 * level), span, ROD_RADIUS * (1 - 0.12 * level)],
  });
  shape(state.sink, arm, 'sphere', MATERIALS.brass, { scale: BEAD_RADIUS * 1.25 * (1 - 0.1 * level) });
  for (const side of [0, 1]) {
    const x = ends[side]!;
    shape(state.sink, arm, 'sphere', MATERIALS.brass, { position: [x, 0, 0], scale: BEAD_RADIUS * (1 - 0.1 * level) });
    shape(state.sink, arm, 'cylinder', MATERIALS.bronze, {
      position: [x, -drops[side]! / 2, 0],
      scale: [WIRE_RADIUS, drops[side]!, WIRE_RADIUS],
    });
  }

  // Each sub-arm rests roughly perpendicular to its parent rod, so sibling subtrees sweep
  // parallel bands instead of swinging through each other. The last arms turn only halfway,
  // which fans their pendant pairs out instead of lining them up one behind the other.
  const rest = isLast ? Math.PI / 4 : Math.PI / 2;
  state.swinging.push({
    node: arm,
    yaw: hand * rest + (hash(seed * 23) - 0.5) * 0.5 * Math.abs(hand),
    amplitude: level === 0 ? 0 : 0.32 + 0.2 * hash(seed * 29),
    roll: 0.035,
    frequency: 0.32 + 0.1 * level + 0.12 * hash(seed * 31),
    phase: hash(seed * 37) * Math.PI * 2,
  });

  const mass = left.mass + right.mass + span * 0.002;
  const depth = Math.max(drops[0]! + left.depth, drops[1]! + right.depth);
  const reach = Math.max(a + left.reach, b + right.reach);
  return { mass, depth, reach };
}

/** Builds a mobile with `levels` arm levels (2^levels pendants) and binds every shape to `sink`. */
function buildInto(sink: ShapeSink, levels: number): Mobile {
  if (!Number.isInteger(levels) || levels < MIN_LEVELS || levels > MAX_LEVELS) {
    throw new RangeError(`Kinetic sculpture levels must be an integer from ${MIN_LEVELS} to ${MAX_LEVELS}, got ${levels}.`);
  }
  const state: BuildState = { sink, arms: [], leaves: [], swinging: [], spinning: [], leafIndex: 0, nodeIndex: levels * 1000 };
  const stage = group({ label: 'stage' });
  const anchor = group({ label: 'anchor' });
  const root = group({ label: 'root' });
  stage.add(anchor);
  anchor.add(root);

  shape(sink, stage, 'box', MATERIALS.plinth, {
    position: [0, PLINTH.height / 2, 0],
    scale: [PLINTH.width, PLINTH.height, PLINTH.depth],
  });
  shape(sink, anchor, 'cylinder', MATERIALS.bronze, {
    position: [0, SUSPENSION_LENGTH / 2, 0],
    scale: [WIRE_RADIUS, SUSPENSION_LENGTH, WIRE_RADIUS],
  });
  const top = buildArm(state, root, [0, 0, 0], 0, levels, 0);

  const bottom = PLINTH.height + CLEARANCE;
  const anchorY = bottom + top.depth;
  anchor.set({ position: [0, anchorY, 0] });

  // Frame the mobile and the top of the plinth together.
  const reach = Math.max(top.reach, PLINTH.width * 0.5);
  // Below the floor line: the camera looks down, so the plinth's front corner projects low.
  const lowest = -0.2;
  const center = [0, (anchorY + lowest) / 2, 0] as const;
  const radius = Math.hypot(reach, (anchorY - lowest) / 2);

  return {
    levels,
    anchor,
    root,
    arms: state.arms,
    leaves: state.leaves,
    ids: { box: [], cylinder: [], sphere: [], torus: [] },
    center,
    radius,
    extent: [reach, (anchorY - lowest) / 2],
    swinging: state.swinging,
    spinning: state.spinning,
  };
}

/** Exact instance counts per mesh for a level count, from a build that touches no collection. */
export function countShapes(levels: number): Record<MeshName, number> {
  const counts: Record<MeshName, number> = { box: 0, cylinder: 0, sphere: 0, torus: 0 };
  buildInto({ add: (mesh) => void counts[mesh]++ }, levels);
  return counts;
}

/** Capacity for every level count: the largest per-mesh count across MIN_LEVELS..MAX_LEVELS. */
export function shapeCapacity(): Record<MeshName, number> {
  const capacity: Record<MeshName, number> = { box: 0, cylinder: 0, sphere: 0, torus: 0 };
  for (let levels = MIN_LEVELS; levels <= MAX_LEVELS; levels++) {
    const counts = countShapes(levels);
    for (const mesh of MESHES) capacity[mesh] = Math.max(capacity[mesh], counts[mesh]);
  }
  return capacity;
}

export function createCollections(): Collections {
  const capacity = shapeCapacity();
  return {
    box: instances({ capacity: capacity.box, attributes: INSTANCE_ATTRIBUTES }),
    cylinder: instances({ capacity: capacity.cylinder, attributes: INSTANCE_ATTRIBUTES }),
    sphere: instances({ capacity: capacity.sphere, attributes: INSTANCE_ATTRIBUTES }),
    torus: instances({ capacity: capacity.torus, attributes: INSTANCE_ATTRIBUTES }),
  };
}

/**
 * Builds the mobile into the collections. The whole build is checked against capacity first, so a
 * level count that would not fit throws before any instance is added.
 */
export function buildMobile(collections: Collections, levels: number): Mobile {
  const counts = countShapes(levels);
  for (const mesh of MESHES) {
    const available = collections[mesh].capacity - collections[mesh].count;
    if (counts[mesh] > available) {
      throw new RangeError(`Kinetic sculpture: ${counts[mesh]} ${mesh} instances do not fit (${available} free).`);
    }
  }
  const ids: Record<MeshName, InstanceId[]> = { box: [], cylinder: [], sphere: [], torus: [] };
  const mobile = buildInto({
    add(mesh, node, part) {
      const collection = collections[mesh];
      const id = collection.add({ tint: part.tint, finish: part.finish });
      collection.bindWorld(id, () => node.worldMatrix);
      ids[mesh].push(id);
    },
  }, levels);
  return { ...mobile, ids };
}

/** Removes exactly the instances a build created; their bindings go with them. */
export function removeMobile(collections: Collections, mobile: Mobile): void {
  for (const mesh of MESHES) {
    for (const id of mobile.ids[mesh]) collections[mesh].remove(id);
    mobile.ids[mesh].length = 0;
  }
}

/** Swaps the mobile for one with a different level count; the collections are reused. */
export function rebuildMobile(collections: Collections, mobile: Mobile, levels: number): Mobile {
  removeMobile(collections, mobile);
  return buildMobile(collections, levels);
}

/**
 * Writes every animated local rotation from (time, swing, rootAngle). Nothing accumulates, so the
 * same input always gives the same pose and no drift builds up over a long session.
 */
export function poseMobile(mobile: Mobile, { time, swing, rootAngle }: PoseInput): void {
  mobile.root.set({ rotation: [0, rootAngle + swing * 0.32 * Math.sin(time * 0.17 + 0.6), 0] });
  for (const arm of mobile.swinging) {
    const wave = Math.sin(time * arm.frequency + arm.phase);
    const tilt = Math.sin(time * arm.frequency * 1.7 + arm.phase * 0.5);
    arm.node.set({ rotation: [0, arm.yaw + swing * arm.amplitude * wave, swing * arm.roll * tilt] });
  }
  for (const part of mobile.spinning) {
    // A constant rate in animation time: changing swing never jumps a ring's angle.
    const angle = part.phase + time * part.rate;
    part.node.set({ rotation: part.axis === 0 ? [angle, 0, 0] : [0, angle, 0] });
  }
}
