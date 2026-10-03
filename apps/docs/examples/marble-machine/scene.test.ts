import { composeMatrix } from 'vgpu/scene';
import { expect, test, vi } from 'vitest';

import { BOX_PARTS, TRIM_PARTS } from './machine';
import { clearMarbles, createScene, syncMarbles, syncParts } from './scene';
import { INSTANCE_CAPACITY, createSimulation, type Marble, type Simulation } from './simulation';

const empty = () => createSimulation({ primeSteps: 0, autoRelease: false });

/** The world a marble's instance must carry: its body pose scaled by the drawn radius, nothing else. */
function expectedWorld(marble: Marble): Float32Array {
  const { position: p, quaternion: q } = marble.body;
  return composeMatrix({ position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w], scale: marble.radius * marble.scale }, new Float32Array(16));
}

test('every part, trim and marble gets an instance with a look attribute', () => {
  const simulation = createSimulation({ paused: true });
  const scene = createScene(simulation);
  expect(scene.collections.parts.count).toBe(BOX_PARTS.length);
  expect(scene.collections.trims.count).toBe(TRIM_PARTS.length);
  expect(scene.collections.marbles.count).toBe(simulation.marbles.length);
  expect(scene.collections.marbles.capacity).toBe(INSTANCE_CAPACITY);
  expect(scene.partIds).toHaveLength(BOX_PARTS.length);
  expect([...scene.marbleIds.keys()]).toEqual(simulation.marbles.map((marble) => marble.id));
});

test('collider parts are drawn from their cannon-es bodies with no extra transform', () => {
  const simulation = empty();
  const scene = createScene(simulation);
  // The bridge reuses one scratch matrix, so copy each world as it is written.
  const writes: Array<[unknown, number[]]> = [];
  const setWorld = scene.collections.parts.setWorld.bind(scene.collections.parts);
  vi.spyOn(scene.collections.parts, 'setWorld').mockImplementation((id, world) => {
    writes.push([id, Array.from(world)]);
    setWorld(id, world);
  });
  syncParts(scene, simulation);
  expect(writes).toHaveLength(BOX_PARTS.length);
  const bodies = new Map(simulation.parts.map(({ part, body }) => [part, body]));
  BOX_PARTS.forEach((part, index) => {
    const [id, world] = writes[index]!;
    expect(id).toBe(scene.partIds[index]);
    const body = bodies.get(part);
    const position = body ? [body.position.x, body.position.y, body.position.z] : [...part.center];
    const quaternion = body ? [body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w] : [...part.quaternion];
    const scale = part.halfExtents.map((half) => half * 2);
    expect(world).toEqual(Array.from(composeMatrix({ position, quaternion, scale }, new Float32Array(16))));
    // The translation column is the body position itself: no parent matrix was applied on top.
    expect(world.slice(12, 15)).toEqual(Array.from(new Float32Array(position)));
  });
});

test('one setWorlds call per frame carries every marble pose straight from its body', () => {
  const simulation = empty();
  const scene = createScene(simulation);
  simulation.release();
  for (let frame = 0; frame < 40; frame += 1) simulation.stepFrame();
  simulation.release();
  for (let frame = 0; frame < 10; frame += 1) simulation.stepFrame();
  const setWorlds = vi.spyOn(scene.collections.marbles, 'setWorlds');
  syncMarbles(scene, simulation);
  expect(setWorlds).toHaveBeenCalledOnce();
  const [ids, rows] = setWorlds.mock.calls[0]!;
  expect(Array.from(ids)).toEqual(simulation.marbles.map((marble) => scene.marbleIds.get(marble.id)));
  simulation.marbles.forEach((marble, row) => {
    const world = rows.subarray(row * 16, row * 16 + 16);
    expect(Array.from(world)).toEqual(Array.from(expectedWorld(marble)));
    const { x, y, z } = marble.body.position;
    expect(Array.from(world.subarray(12, 15))).toEqual(Array.from(new Float32Array([x, y, z])));
    // A uniform scale of the collider radius: the drawn sphere is the physics sphere.
    expect(Math.hypot(world[0]!, world[1]!, world[2]!)).toBeCloseTo(marble.radius, 6);
  });
});

test('a frame that recycles and spawns at once fits a full collection', () => {
  const scene = createScene(empty());
  const marble = (id: number) => ({
    id,
    palette: id % 8,
    radius: 0.1,
    scale: 1,
    retiredAt: -1,
    body: { position: { x: 0, y: 1, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
  });
  const live = (ids: number[]) => ({ marbles: ids.map(marble) }) as unknown as Simulation;
  const full = Array.from({ length: INSTANCE_CAPACITY }, (_, id) => id);
  syncMarbles(scene, live(full));
  expect(scene.collections.marbles.count).toBe(INSTANCE_CAPACITY);
  // Marble 0 leaves and marble 48 arrives in the same frame: the stale slot is freed first.
  syncMarbles(scene, live([...full.slice(1), INSTANCE_CAPACITY]));
  expect(scene.collections.marbles.count).toBe(INSTANCE_CAPACITY);
  expect(scene.marbleIds.has(0)).toBe(false);
  expect(scene.marbleIds.has(INSTANCE_CAPACITY)).toBe(true);
});

test('instances follow the simulation as marbles are recycled and after a reset', () => {
  const simulation = createSimulation({ primeSteps: 0, autoRelease: false, capacity: 2 });
  const scene = createScene(simulation);
  const remove = vi.spyOn(scene.collections.marbles, 'remove');
  for (let frame = 0; frame < 60 * 6; frame += 1) {
    if (frame % 30 === 0) simulation.release();
    simulation.stepFrame();
    syncMarbles(scene, simulation);
    expect(scene.collections.marbles.count).toBe(simulation.marbles.length);
    expect([...scene.marbleIds.keys()].sort((a, b) => a - b)).toEqual(simulation.marbles.map((marble) => marble.id).sort((a, b) => a - b));
  }
  expect(remove.mock.calls.length).toBeGreaterThan(5);

  // reset() rebuilds the world and restarts ids at 0: stale handles must go first.
  simulation.reset();
  clearMarbles(scene);
  expect(scene.collections.marbles.count).toBe(0);
  expect(scene.marbleIds.size).toBe(0);
  simulation.release();
  syncMarbles(scene, simulation);
  expect(scene.collections.marbles.count).toBe(1);
  expect(scene.marbleIds.get(0)).toBeDefined();
});
