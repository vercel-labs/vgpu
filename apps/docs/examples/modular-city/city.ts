// The editable city model. vgpu/scene owns the hierarchy (root → neighborhood → building → part
// nodes) and the instance records; this module owns application IDs, selection and edits.
// DOM-free: the renderer, the thumbnail and the tests all drive it directly.

import { group, instances, srgb, type InstanceCollection, type InstanceId, type SceneNode } from "vgpu/scene";

import {
  DEFAULT_POPULATION,
  designBuilding,
  DISTRICT_INDEX,
  MATERIAL,
  maxCapacity,
  planCity,
  SLAB_THICKNESS,
  SLAB_TOP,
  SWATCHES,
  TILE_SIZE,
  type BuildingDesign,
  type CityPlan,
  type Mesh,
  type NeighborhoodPlan,
  type PartTotals,
} from "./layout";

export const ATTRIBUTES = {
  /** Application pick code: a building ID, or NEIGHBORHOOD_PICK | index for a slab. */
  pickId: "uint32",
  /** Linear RGB base color. */
  tint: "float32x3",
  /** (material, facade, neighborhood, seed) */
  style: "uint32x4",
} as const;

export type CityInstances = InstanceCollection<typeof ATTRIBUTES>;
export type CityCollections = Readonly<Record<Mesh, CityInstances>>;

export const MESHES: readonly Mesh[] = ["box", "roof", "tree"];
export const NEIGHBORHOOD_PICK = 0x80000000;
export const NO_SELECTION = 0;

export const OFFSET_LIMIT = 1.2;
export const LIFT_LIMIT = 3;

export interface PartRecord {
  readonly mesh: Mesh;
  readonly handle: InstanceId;
  readonly node: SceneNode;
  readonly paint: boolean;
}

export interface BuildingRecord {
  /** Application ID: monotonic, never reused, unrelated to collection handles or slots. */
  readonly id: number;
  readonly neighborhood: number;
  readonly lot: number;
  readonly kind: BuildingDesign["kind"];
  swatch: number;
  readonly node: SceneNode;
  readonly parts: readonly PartRecord[];
}

export interface NeighborhoodOffset {
  x: number;
  z: number;
  lift: number;
}

export interface NeighborhoodRecord {
  readonly plan: NeighborhoodPlan;
  readonly node: SceneNode;
  readonly slab: PartRecord;
  readonly offset: NeighborhoodOffset;
  /** lot index → building ID */
  readonly occupied: Map<number, number>;
}

export interface Selection {
  /** Selected building ID, or NO_SELECTION. */
  building: number;
  /** Selected neighborhood index (always valid). */
  neighborhood: number;
}

export interface City {
  readonly root: SceneNode;
  readonly collections: CityCollections;
  readonly capacity: PartTotals;
  readonly selection: Readonly<Selection>;
  readonly plan: CityPlan;
  /** Bumps on every rebuild; pick results from an older generation are ignored. */
  readonly generation: number;
  /** Bumps whenever synced worlds changed (shadow maps re-render on change). */
  readonly worldRevision: number;
  readonly neighborhoods: readonly NeighborhoodRecord[];
  buildingCount(): number;
  buildingIds(neighborhood?: number): number[];
  building(id: number): BuildingRecord | undefined;
  /** Applies a pick code (building ID, neighborhood code, or 0). Returns true when it changed. */
  select(code: number): boolean;
  selectNeighborhood(index: number): void;
  /** Steps the selected building within the selected neighborhood (keyboard selection). */
  step(direction: 1 | -1): number;
  recolor(id: number, swatch?: number): boolean;
  remove(id: number): boolean;
  /** Fills the lowest vacant lot of a neighborhood. Returns the new ID or undefined. */
  add(neighborhood: number): number | undefined;
  moveNeighborhood(index: number, offset: Partial<NeighborhoodOffset>): void;
  rebuild(population?: number): void;
  /** Copies bound world sources after a change. Returns the number of copied records. */
  sync(): number;
}

export interface CityOptions {
  readonly population?: number;
  readonly capacity?: PartTotals;
}

const FIRST_SELECTED_NEIGHBORHOOD = 5;

export function createCity(options: CityOptions = {}): City {
  const capacity = options.capacity ?? maxCapacity();
  const collections: CityCollections = {
    box: instances({ capacity: capacity.box, attributes: ATTRIBUTES }),
    roof: instances({ capacity: capacity.roof, attributes: ATTRIBUTES }),
    tree: instances({ capacity: capacity.tree, attributes: ATTRIBUTES }),
  };
  const swatchColors = SWATCHES.map(({ color }) => srgb(color));
  const root = group({ label: "city" });
  const buildings = new Map<number, BuildingRecord>();
  let neighborhoods: NeighborhoodRecord[] = [];
  let plan: CityPlan = planCity(options.population ?? DEFAULT_POPULATION);
  let generation = 0;
  let worldRevision = 0;
  let nextId = 1;
  let dirty = true;
  const selection: Selection = { building: NO_SELECTION, neighborhood: FIRST_SELECTED_NEIGHBORHOOD };

  function addPart(
    parent: SceneNode,
    mesh: Mesh,
    paint: boolean,
    values: { pickId: number; tint: ArrayLike<number>; style: ArrayLike<number> },
    position: readonly [number, number, number],
    scale: readonly [number, number, number]
  ): PartRecord {
    const node = group({ position, scale });
    parent.add(node);
    const collection = collections[mesh];
    const handle = collection.add(values);
    collection.bindWorld(handle, () => node.worldMatrix);
    return { mesh, handle, node, paint };
  }

  function createBuilding(record: NeighborhoodRecord, lotIndex: number, id: number): BuildingRecord {
    const { plan: neighborhood } = record;
    const lot = neighborhood.lots[lotIndex]!;
    const design = designBuilding(neighborhood.district, lot, neighborhood.center);
    const node = group({ position: [lot.x, SLAB_TOP, lot.z], label: `building ${id}` });
    record.node.add(node);
    const swatch = swatchColors[design.swatch]!;
    const parts = design.parts.map((part, index) =>
      addPart(
        node,
        part.mesh,
        part.paint,
        {
          pickId: id,
          tint: part.paint ? swatch : srgb(part.color),
          style: [part.material, part.facade, neighborhood.index, (lot.seed + index * 0x9e37) >>> 0],
        },
        part.position,
        part.scale
      )
    );
    const building: BuildingRecord = {
      id,
      neighborhood: neighborhood.index,
      lot: lotIndex,
      kind: design.kind,
      swatch: design.swatch,
      node,
      parts,
    };
    buildings.set(id, building);
    record.occupied.set(lotIndex, id);
    dirty = true;
    return building;
  }

  function releaseParts(parts: readonly PartRecord[]): void {
    for (const part of parts) collections[part.mesh].remove(part.handle);
  }

  function clear(): void {
    for (const building of buildings.values()) releaseParts(building.parts);
    buildings.clear();
    for (const neighborhood of neighborhoods) {
      releaseParts([neighborhood.slab]);
      neighborhood.node.removeFromParent();
    }
    neighborhoods = [];
  }

  function build(population: number): void {
    plan = planCity(population);
    generation++;
    neighborhoods = plan.neighborhoods.map((neighborhood) => {
      const node = group({ position: [neighborhood.center[0], 0, neighborhood.center[1]], label: neighborhood.name });
      root.add(node);
      const slab = addPart(
        node,
        "box",
        false,
        {
          pickId: (NEIGHBORHOOD_PICK | neighborhood.index) >>> 0,
          tint: srgb(neighborhood.district === "park" ? "#8da567" : "#d8cbb2"),
          style: [MATERIAL.slab, DISTRICT_INDEX[neighborhood.district], neighborhood.index, 0],
        },
        [0, SLAB_TOP - SLAB_THICKNESS / 2, 0],
        [TILE_SIZE, SLAB_THICKNESS, TILE_SIZE]
      );
      const record: NeighborhoodRecord = {
        plan: neighborhood,
        node,
        slab,
        offset: { x: 0, z: 0, lift: 0 },
        occupied: new Map(),
      };
      return record;
    });
    for (const record of neighborhoods) {
      for (const lot of record.plan.lots) {
        if (!lot.vacant) createBuilding(record, lot.index, nextId++);
      }
    }
    selection.building = NO_SELECTION;
    selection.neighborhood = FIRST_SELECTED_NEIGHBORHOOD;
    dirty = true;
  }

  build(plan.population);

  const city: City = {
    root,
    collections,
    capacity,
    selection,
    get plan() {
      return plan;
    },
    get generation() {
      return generation;
    },
    get worldRevision() {
      return worldRevision;
    },
    get neighborhoods() {
      return neighborhoods;
    },
    buildingCount() {
      let count = 0;
      for (const building of buildings.values()) if (building.kind !== "grove") count++;
      return count;
    },
    buildingIds(neighborhood) {
      const ids: number[] = [];
      for (const building of buildings.values()) {
        if (neighborhood === undefined || building.neighborhood === neighborhood) ids.push(building.id);
      }
      return ids;
    },
    building(id) {
      return buildings.get(id);
    },
    select(code) {
      const before = `${selection.building}:${selection.neighborhood}`;
      if (code === NO_SELECTION) {
        selection.building = NO_SELECTION;
      } else if (code >= NEIGHBORHOOD_PICK) {
        const index = code - NEIGHBORHOOD_PICK;
        if (!neighborhoods[index]) return false;
        selection.building = NO_SELECTION;
        selection.neighborhood = index;
      } else {
        const building = buildings.get(code);
        if (!building) return false;
        selection.building = building.id;
        selection.neighborhood = building.neighborhood;
      }
      return before !== `${selection.building}:${selection.neighborhood}`;
    },
    selectNeighborhood(index) {
      if (!neighborhoods[index]) throw new RangeError(`No neighborhood ${index}`);
      selection.neighborhood = index;
      const building = buildings.get(selection.building);
      if (building && building.neighborhood !== index) selection.building = NO_SELECTION;
    },
    step(direction) {
      const ids = city.buildingIds(selection.neighborhood);
      if (ids.length === 0) {
        selection.building = NO_SELECTION;
        return NO_SELECTION;
      }
      const current = ids.indexOf(selection.building);
      const next =
        current < 0 ? (direction > 0 ? 0 : ids.length - 1) : (current + direction + ids.length) % ids.length;
      selection.building = ids[next]!;
      return selection.building;
    },
    recolor(id, swatch) {
      const building = buildings.get(id);
      if (!building) return false;
      building.swatch = swatch ?? (building.swatch + 1) % SWATCHES.length;
      const tint = swatchColors[building.swatch]!;
      for (const part of building.parts) if (part.paint) collections[part.mesh].set(part.handle, { tint });
      return true;
    },
    remove(id) {
      const building = buildings.get(id);
      if (!building) return false;
      // Swap-remove moves the last record of each collection into the freed slot. Application
      // IDs live in the records and in this map, so no other building's identity changes.
      releaseParts(building.parts);
      building.node.removeFromParent();
      buildings.delete(id);
      neighborhoods[building.neighborhood]!.occupied.delete(building.lot);
      if (selection.building === id) selection.building = NO_SELECTION;
      worldRevision++;
      return true;
    },
    add(index) {
      const record = neighborhoods[index];
      if (!record) return undefined;
      const lot = record.plan.lots.find(({ index: lotIndex }) => !record.occupied.has(lotIndex));
      if (!lot) return undefined;
      const design = designBuilding(record.plan.district, lot, record.plan.center);
      for (const mesh of MESHES) {
        const needed = design.parts.filter((part) => part.mesh === mesh).length;
        const collection = collections[mesh];
        if (collection.count + needed > collection.capacity) return undefined;
      }
      const building = createBuilding(record, lot.index, nextId++);
      selection.building = building.id;
      selection.neighborhood = index;
      return building.id;
    },
    moveNeighborhood(index, offset) {
      const record = neighborhoods[index];
      if (!record) throw new RangeError(`No neighborhood ${index}`);
      const next = record.offset;
      if (offset.x !== undefined) next.x = clamp(offset.x, -OFFSET_LIMIT, OFFSET_LIMIT);
      if (offset.z !== undefined) next.z = clamp(offset.z, -OFFSET_LIMIT, OFFSET_LIMIT);
      if (offset.lift !== undefined) next.lift = clamp(offset.lift, 0, LIFT_LIMIT);
      const [x, z] = record.plan.center;
      record.node.set({ position: [x + next.x, next.lift, z + next.z] });
      dirty = true;
    },
    rebuild(population = plan.population) {
      clear();
      build(population);
    },
    sync() {
      if (!dirty) return 0;
      dirty = false;
      let copied = 0;
      for (const mesh of MESHES) copied += collections[mesh].syncWorlds();
      worldRevision++;
      return copied;
    },
  };
  return city;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
