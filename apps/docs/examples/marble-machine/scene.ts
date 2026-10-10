import { box, composeMatrix, cylinder, instances, sphere, type InstanceCollection, type InstanceId } from 'vgpu/scene';

import { BOX_PARTS, MATERIAL, TRIM_PARTS, type BoxPart, type TrimPart } from './machine';
import { INSTANCE_CAPACITY, type Simulation } from './simulation';

/**
 * The bridge from physics to drawable instances. Every collection carries the
 * same `look` attribute (material or palette in x, a per-instance seed in y) so
 * one depth-only shader can draw all three into the shadow map.
 *
 * Worlds come straight from cannon-es: position + quaternion + scale through
 * composeMatrix. There is no hierarchy and no parent matrix to multiply.
 */

const attributes = { look: 'float32x4' } as const;
type Look = typeof attributes;

export const MESHES = ['parts', 'trims', 'marbles'] as const;
export type MeshName = (typeof MESHES)[number];

/** Unit recipes, sized per instance by the world matrix scale. */
export const RECIPES = {
  parts: () => box({ size: 1 }),
  trims: () => cylinder({ radius: 1, height: 1, radialSegments: 24 }),
  marbles: () => sphere({ radius: 1, widthSegments: 32, heightSegments: 18 }),
} as const;

export interface Scene {
  readonly collections: Record<MeshName, InstanceCollection<Look>>;
  /** Static box instances in BOX_PARTS order. */
  readonly partIds: readonly InstanceId[];
  /** Simulation marble id → instance handle; handles survive swap-removal. */
  readonly marbleIds: Map<number, InstanceId>;
}

const QUARTER_TURN_X = [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as const;

// Scratch buffers reused every frame: the bridge allocates nothing per marble.
const position = [0, 0, 0];
const quaternion = [0, 0, 0, 1];
const scale = [1, 1, 1];
const matrix = new Float32Array(16);
const marbleRows = new Float32Array(INSTANCE_CAPACITY * 16);
const marbleHandles: InstanceId[] = [];
const seen = new Set<number>();

/** Stable per-instance variation from an integer, without Math.random. */
function seedOf(index: number): number {
  let value = Math.imul(index + 1, 0x9e3779b1) >>> 0;
  value ^= value >>> 16;
  return (Math.imul(value, 0x85ebca6b) >>> 0) / 4294967296;
}

function partWorld(part: BoxPart, out: Float32Array, pose?: { position: { x: number; y: number; z: number }; quaternion: { x: number; y: number; z: number; w: number } }): Float32Array {
  if (pose) {
    position[0] = pose.position.x;
    position[1] = pose.position.y;
    position[2] = pose.position.z;
    quaternion[0] = pose.quaternion.x;
    quaternion[1] = pose.quaternion.y;
    quaternion[2] = pose.quaternion.z;
    quaternion[3] = pose.quaternion.w;
  } else {
    position.splice(0, 3, ...part.center);
    quaternion.splice(0, 4, ...part.quaternion);
  }
  scale[0] = part.halfExtents[0] * 2;
  scale[1] = part.halfExtents[1] * 2;
  scale[2] = part.halfExtents[2] * 2;
  return composeMatrix({ position, quaternion, scale }, out);
}

function trimWorld(trim: TrimPart, out: Float32Array): Float32Array {
  return composeMatrix(
    {
      position: trim.center,
      quaternion: trim.axis === 'z' ? QUARTER_TURN_X : [0, 0, 0, 1],
      scale: [trim.radius, trim.height, trim.radius],
    },
    out,
  );
}

export function createScene(simulation: Simulation): Scene {
  const collections = {
    parts: instances({ capacity: BOX_PARTS.length, attributes }),
    trims: instances({ capacity: TRIM_PARTS.length, attributes }),
    marbles: instances({ capacity: INSTANCE_CAPACITY, attributes }),
  };
  const partIds = BOX_PARTS.map((part, index) =>
    // look.z = 1: boxes get bevelled edges in solids.wgsl.
    collections.parts.add({ look: [MATERIAL[part.material], seedOf(index), 1, 0] }),
  );
  TRIM_PARTS.forEach((trim, index) => {
    const id = collections.trims.add({ look: [MATERIAL[trim.material], seedOf(index + 100), 0, 0] });
    collections.trims.setWorld(id, trimWorld(trim, matrix));
  });
  const scene: Scene = { collections, partIds, marbleIds: new Map() };
  syncParts(scene, simulation);
  syncMarbles(scene, simulation);
  return scene;
}

/**
 * Static boxes: contact parts take their pose from their cannon-es body (so the
 * drawn ramp is the collider), decorative parts from the layout. Call after
 * creation and after every reset, which rebuilds the bodies.
 */
export function syncParts(scene: Scene, simulation: Simulation): void {
  const bodies = new Map(simulation.parts.map(({ part, body }) => [part, body]));
  BOX_PARTS.forEach((part, index) => {
    scene.collections.parts.setWorld(scene.partIds[index]!, partWorld(part, matrix, bodies.get(part)));
  });
}

/**
 * Marbles: drop instances whose body is gone, add instances for new bodies,
 * then write every live world in one setWorlds call. Removing first keeps the
 * collection at the live count, so a frame that recycles one marble and spawns
 * another fits even a full collection.
 */
export function syncMarbles(scene: Scene, simulation: Simulation): void {
  const { marbles: collection } = scene.collections;
  seen.clear();
  for (const marble of simulation.marbles) seen.add(marble.id);
  for (const [marbleId, id] of scene.marbleIds) {
    if (seen.has(marbleId)) continue;
    collection.remove(id);
    scene.marbleIds.delete(marbleId);
  }
  marbleHandles.length = 0;
  simulation.marbles.forEach((marble, row) => {
    let id = scene.marbleIds.get(marble.id);
    if (id === undefined) {
      id = collection.add({ look: [marble.palette, seedOf(marble.id), 0, 0] });
      scene.marbleIds.set(marble.id, id);
    }
    marbleHandles.push(id);
    const { position: p, quaternion: q } = marble.body;
    position[0] = p.x;
    position[1] = p.y;
    position[2] = p.z;
    quaternion[0] = q.x;
    quaternion[1] = q.y;
    quaternion[2] = q.z;
    quaternion[3] = q.w;
    // The unit sphere scaled by the collider radius (and the recycle shrink).
    composeMatrix({ position, quaternion, scale: marble.radius * marble.scale }, matrix);
    marbleRows.set(matrix, row * 16);
  });
  if (marbleHandles.length > 0) collection.setWorlds(marbleHandles, marbleRows);
}

/** Forget every marble instance, e.g. after the simulation was reset. */
export function clearMarbles(scene: Scene): void {
  for (const id of scene.marbleIds.values()) scene.collections.marbles.remove(id);
  scene.marbleIds.clear();
}
