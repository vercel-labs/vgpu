import { describe, expect, it, vi } from "vitest";

// Records what the city writes into each collection through the public InstanceCollection API:
// attribute values per handle, bound world sources, and the worlds a syncWorlds() call copied.
const recorded = vi.hoisted(() => ({
  values: new Map<number, Record<string, unknown>>(),
  sources: new Map<number, () => ArrayLike<number>>(),
  copied: new Map<number, number[]>(),
}));

vi.mock("vgpu/scene", async (importOriginal) => {
  const scene = await importOriginal<typeof import("vgpu/scene")>();
  return {
    ...scene,
    instances: ((options: Parameters<typeof scene.instances>[0]) => {
      const collection = scene.instances(options);
      const { add, set, remove, bindWorld, syncWorlds } = collection;
      const handles = new Set<number>();
      Object.assign(collection, {
        add: (values: Record<string, unknown>) => {
          const handle = add.call(collection, values as never);
          handles.add(handle);
          recorded.values.set(handle, { ...values });
          return handle;
        },
        set: (handle: number, values: Record<string, unknown>) => {
          set.call(collection, handle as never, values as never);
          Object.assign(recorded.values.get(handle)!, values);
        },
        remove: (handle: number) => {
          remove.call(collection, handle as never);
          handles.delete(handle);
          recorded.values.delete(handle);
          recorded.sources.delete(handle);
          recorded.copied.delete(handle);
        },
        bindWorld: (handle: number, source: () => ArrayLike<number>) => {
          bindWorld.call(collection, handle as never, source);
          recorded.sources.set(handle, source);
        },
        syncWorlds: () => {
          const copied = syncWorlds.call(collection);
          for (const handle of handles) recorded.copied.set(handle, Array.from(recorded.sources.get(handle)!()));
          return copied;
        },
      });
      return collection;
    }) as typeof scene.instances,
  };
});

import { srgb } from "vgpu/scene";

import {
  createCity,
  LIFT_LIMIT,
  MESHES,
  NEIGHBORHOOD_PICK,
  NO_SELECTION,
  OFFSET_LIMIT,
  type BuildingRecord,
  type City,
} from "./city";
import { maxCapacity, planCapacity, planCity, POPULATIONS, SWATCHES, type PartTotals } from "./layout";

function counts(city: City): PartTotals {
  return { box: city.collections.box.count, roof: city.collections.roof.count, tree: city.collections.tree.count };
}

function translation(handle: number): number[] {
  return recorded.copied.get(handle)!.slice(12, 15);
}

function tintOf(handle: number): number[] {
  return Array.from(recorded.values.get(handle)!.tint as ArrayLike<number>);
}

function allBuildings(city: City): BuildingRecord[] {
  return city.buildingIds().map((id) => city.building(id)!);
}

function bound(city: City): number {
  return MESHES.reduce((total, mesh) => total + city.collections[mesh].count, 0);
}

describe("modular-city model", () => {
  it("lays out every population preset deterministically within the fixed capacity", () => {
    const capacity = maxCapacity();
    for (const population of POPULATIONS) {
      expect(JSON.stringify(planCity(population))).toBe(JSON.stringify(planCity(population)));
      const city = createCity({ population });
      for (const mesh of MESHES) expect(city.collections[mesh].count).toBeLessThanOrEqual(capacity[mesh]);
      expect(city.collections.box.capacity).toBe(capacity.box);
    }
  });

  it("delete swap-removes records without changing any other building's identity or the selection", () => {
    const city = createCity({ population: 256 });
    const box = city.collections.box;
    // The building owning the last box record is the one swap-remove moves into the freed slot.
    const moved = allBuildings(city).find((building) =>
      building.parts.some((part) => part.mesh === "box" && box.slotOf(part.handle) === box.count - 1)
    )!;
    const victim = allBuildings(city).find((building) => building.id !== moved.id && building.kind !== "grove")!;
    const movedPart = moved.parts.find((part) => part.mesh === "box" && box.slotOf(part.handle) === box.count - 1)!;
    const before = counts(city);
    const ids = city.buildingIds();
    const buildingCount = city.buildingCount();
    expect(city.select(moved.id)).toBe(true);

    expect(city.remove(victim.id)).toBe(true);

    expect(box.slotOf(movedPart.handle)).toBeLessThan(box.count);
    expect(city.selection.building).toBe(moved.id);
    expect(city.building(victim.id)).toBeUndefined();
    expect(city.buildingIds()).toEqual(ids.filter((id) => id !== victim.id));
    expect(city.buildingCount()).toBe(buildingCount - 1);
    for (const mesh of MESHES) {
      const removed = victim.parts.filter((part) => part.mesh === mesh).length;
      expect(city.collections[mesh].count).toBe(before[mesh] - removed);
    }
    for (const building of allBuildings(city)) {
      for (const part of building.parts) {
        const collection = city.collections[part.mesh];
        expect(collection.idAt(collection.slotOf(part.handle))).toBe(part.handle);
        expect(recorded.values.get(part.handle)!.pickId).toBe(building.id);
      }
    }
    expect(city.remove(victim.id)).toBe(false);

    // Deleting the selected building clears the selection; IDs are never reused.
    expect(city.remove(moved.id)).toBe(true);
    expect(city.selection.building).toBe(NO_SELECTION);
    const added = city.add(victim.neighborhood)!;
    expect(added).toBeGreaterThan(Math.max(...ids));
    expect(city.selection).toEqual({ building: added, neighborhood: victim.neighborhood });
    expect(recorded.values.get(city.building(added)!.parts[0]!.handle)!.pickId).toBe(added);
  });

  it("a neighborhood edit updates exactly that neighborhood's worlds at the next sync", () => {
    const city = createCity({ population: 256 });
    expect(city.sync()).toBe(bound(city));
    expect(city.sync()).toBe(0);
    const edited = 3;
    const handles = new Map<number, number>();
    for (const building of allBuildings(city)) {
      for (const part of building.parts) handles.set(part.handle, building.neighborhood);
    }
    for (const neighborhood of city.neighborhoods) handles.set(neighborhood.slab.handle, neighborhood.plan.index);
    const start = new Map([...handles.keys()].map((handle) => [handle, translation(handle)]));
    const revision = city.worldRevision;

    city.moveNeighborhood(edited, { x: 0.5, lift: 2 });
    // Nothing reaches the records until the explicit sync.
    for (const handle of handles.keys()) expect(translation(handle)).toEqual(start.get(handle));

    expect(city.sync()).toBe(bound(city));
    expect(city.worldRevision).toBe(revision + 1);
    let moved = 0;
    for (const [handle, neighborhood] of handles) {
      const [x, y, z] = start.get(handle)!;
      if (neighborhood === edited) {
        moved++;
        const next = translation(handle);
        expect(next[0]).toBeCloseTo(x! + 0.5, 5);
        expect(next[1]).toBeCloseTo(y! + 2, 5);
        expect(next[2]).toBeCloseTo(z!, 5);
      } else {
        expect(translation(handle)).toEqual([x, y, z]);
      }
    }
    expect(moved).toBeGreaterThan(1);

    city.moveNeighborhood(edited, { x: 9, z: -9, lift: 99 });
    expect(city.neighborhoods[edited]!.offset).toEqual({ x: OFFSET_LIMIT, z: -OFFSET_LIMIT, lift: LIFT_LIMIT });
    expect(() => city.moveNeighborhood(99, { x: 0 })).toThrow(RangeError);
  });

  it("counts reach zero buildings, return after reset, and stop at capacity", () => {
    const city = createCity({ population: 256 });
    const fresh = counts(city);
    for (const id of city.buildingIds()) city.remove(id);
    expect(city.buildingCount()).toBe(0);
    expect(counts(city)).toEqual({ box: city.neighborhoods.length, roof: 0, tree: 0 });
    expect(city.step(1)).toBe(NO_SELECTION);
    expect(city.sync()).toBe(city.neighborhoods.length);

    const generation = city.generation;
    city.moveNeighborhood(2, { lift: 1 });
    city.rebuild();
    expect(counts(city)).toEqual(fresh);
    expect(city.generation).toBe(generation + 1);
    expect(city.selection).toEqual({ building: NO_SELECTION, neighborhood: 5 });
    expect(city.neighborhoods.every(({ offset }) => offset.x === 0 && offset.z === 0 && offset.lift === 0)).toBe(true);

    // Every lot filled: the planned capacity is reached exactly and add() reports no room.
    const capacity = planCapacity(planCity(256));
    const full = createCity({ population: 256, capacity });
    for (const neighborhood of full.neighborhoods) {
      while (full.add(neighborhood.plan.index) !== undefined) {
        // fill the vacant lots
      }
    }
    expect(counts(full)).toEqual(capacity);

    // Collections sized to the occupied lots: add() refuses before touching any record.
    const tight = createCity({ population: 256, capacity: fresh });
    const vacant = tight.neighborhoods.find((neighborhood) => neighborhood.occupied.size < neighborhood.plan.lots.length)!;
    tight.select(tight.buildingIds()[0]!);
    const selection = { ...tight.selection };
    expect(tight.add(vacant.plan.index)).toBeUndefined();
    expect(counts(tight)).toEqual(fresh);
    expect(tight.selection).toEqual(selection);
  });

  it("recolors only paint parts and resolves pick codes, neighborhoods and keyboard steps", () => {
    const city = createCity({ population: 256 });
    const building = allBuildings(city).find((record) => record.kind === "tower" || record.kind === "midrise")!;
    const fixed = building.parts.filter((part) => !part.paint).map((part) => tintOf(part.handle));
    const next = (building.swatch + 1) % SWATCHES.length;
    expect(city.recolor(building.id)).toBe(true);
    expect(building.swatch).toBe(next);
    for (const part of building.parts.filter(({ paint }) => paint)) {
      expect(tintOf(part.handle)).toEqual(Array.from(srgb(SWATCHES[next]!.color)));
    }
    expect(building.parts.filter((part) => !part.paint).map((part) => tintOf(part.handle))).toEqual(fixed);
    expect(city.recolor(-1)).toBe(false);

    expect(city.select(building.id)).toBe(true);
    expect(city.selection).toEqual({ building: building.id, neighborhood: building.neighborhood });
    expect(city.select(building.id)).toBe(false);
    expect(city.select((NEIGHBORHOOD_PICK | 7) >>> 0)).toBe(true);
    expect(city.selection).toEqual({ building: NO_SELECTION, neighborhood: 7 });
    expect(city.select(123456)).toBe(false);
    expect(city.select((NEIGHBORHOOD_PICK | 99) >>> 0)).toBe(false);
    expect(city.selection).toEqual({ building: NO_SELECTION, neighborhood: 7 });

    const ids = city.buildingIds(7);
    expect(city.step(1)).toBe(ids[0]);
    expect(city.step(-1)).toBe(ids.at(-1));
    expect(city.step(1)).toBe(ids[0]);
    city.selectNeighborhood(2);
    expect(city.selection).toEqual({ building: NO_SELECTION, neighborhood: 2 });
    expect(() => city.selectNeighborhood(16)).toThrow(RangeError);
  });
});
