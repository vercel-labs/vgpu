// Deterministic city plan: a 4×4 grid of neighborhood tiles split into lots, and a building
// design for every lot. Pure data — no vgpu objects — so tests and the thumbnail share it.

export type District = "oldtown" | "midtown" | "downtown" | "park";

export const GRID = 4;
export const TILE_SIZE = 14;
export const ROAD_WIDTH = 3.2;
export const TILE_PITCH = TILE_SIZE + ROAD_WIDTH;
export const CITY_HALF_EXTENT = (GRID * TILE_PITCH) / 2;
export const SLAB_TOP = 0.3;
export const SLAB_THICKNESS = 1.4;
export const FLOOR_HEIGHT = 0.42;

export const POPULATIONS = [256, 512, 1024, 2048] as const;
export type Population = (typeof POPULATIONS)[number];
export const DEFAULT_POPULATION: Population = 1024;

// Rows run from -Z to +Z, columns from -X to +X. O old town, M midtown, D downtown, P park.
const DISTRICT_ROWS = ["OOMP", "MDDO", "ODDM", "PMOO"] as const;
const DISTRICT_CODES = { O: "oldtown", M: "midtown", D: "downtown", P: "park" } as const;
const DISTRICT_WEIGHT: Record<District, number> = {
  oldtown: 1.4,
  midtown: 1.1,
  downtown: 0.8,
  park: 0,
};

export const DISTRICT_INDEX: Record<District, number> = {
  oldtown: 0,
  midtown: 1,
  downtown: 2,
  park: 3,
};

// Material codes shared with city.wgsl (style.x).
export const MATERIAL = {
  facade: 0,
  glass: 1,
  roof: 2,
  plain: 3,
  slab: 4,
  foliage: 5,
  trunk: 6,
} as const;

// Facade codes (style.y) for MATERIAL.facade and MATERIAL.glass.
export const FACADE = {
  house: 0,
  punched: 1,
  ribbon: 2,
  storefront: 3,
} as const;

export type Mesh = "box" | "roof" | "tree";

export interface Lot {
  readonly index: number;
  /** Lot center relative to the neighborhood origin. */
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
  readonly seed: number;
  readonly vacant: boolean;
}

export interface NeighborhoodPlan {
  readonly index: number;
  readonly district: District;
  readonly name: string;
  readonly center: readonly [number, number];
  readonly lots: readonly Lot[];
}

export interface CityPlan {
  readonly population: number;
  readonly neighborhoods: readonly NeighborhoodPlan[];
}

export interface PartDesign {
  readonly mesh: Mesh;
  /** Paint parts take the building swatch and follow recoloring. */
  readonly paint: boolean;
  readonly material: number;
  readonly facade: number;
  /** Part center relative to the building origin (lot center on the slab top). */
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  /** sRGB color for fixed parts; ignored for paint parts. */
  readonly color: string;
}

export interface BuildingDesign {
  readonly kind: "house" | "midrise" | "tower" | "grove";
  readonly swatch: number;
  readonly parts: readonly PartDesign[];
}

// sRGB swatches. Index order is the recolor cycle.
export const SWATCHES = [
  { name: "ivory", color: "#efe5cf" },
  { name: "sand", color: "#e0c9a0" },
  { name: "terracotta", color: "#c96a42" },
  { name: "ochre", color: "#d8a043" },
  { name: "rose", color: "#d79483" },
  { name: "sage", color: "#a7b88c" },
  { name: "teal glass", color: "#3a9a98" },
] as const;

const SWATCH = {
  ivory: 0,
  sand: 1,
  terracotta: 2,
  ochre: 3,
  rose: 4,
  sage: 5,
  teal: 6,
} as const;

const ROOF_COLORS = ["#b5532f", "#c4643a", "#a84a2c", "#bd5a34"] as const;
const FOLIAGE_COLORS = ["#6f8f4e", "#5f8248", "#7f9a55", "#58773f"] as const;
const STONE_COLOR = "#d9cdb6";
const DARK_ROOF_COLOR = "#8e8a82";
const TRUNK_COLOR = "#6b4b33";

const NAMES: Record<District, readonly string[]> = {
  oldtown: ["Old Harbor", "Lantern Row", "Kiln Quarter", "Fig Lane", "Cistern Hill", "Rope Walk"],
  midtown: ["Arcade Ward", "Mint Street", "Gallery Row", "Tramline"],
  downtown: ["Exchange", "Meridian", "Crown Plaza", "Glasswharf"],
  park: ["North Gardens", "Orchard Park"],
};

export function districtAt(index: number): District {
  const row = Math.floor(index / GRID);
  const column = index % GRID;
  const code = DISTRICT_ROWS[row]![column] as keyof typeof DISTRICT_CODES;
  return DISTRICT_CODES[code];
}

export function tileCenter(index: number): [number, number] {
  const row = Math.floor(index / GRID);
  const column = index % GRID;
  return [(column - (GRID - 1) / 2) * TILE_PITCH, (row - (GRID - 1) / 2) * TILE_PITCH];
}

/** Integer hash (lowbias32) so layouts match on every platform. */
export function hashU32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

export function hashUnit(...values: number[]): number {
  let h = 0x9e3779b9;
  for (const value of values) h = hashU32(h ^ (value >>> 0));
  return h / 0x100000000;
}

/** Splits `population` buildings across non-park tiles by district weight (largest remainder). */
export function buildingsPerTile(population: number): number[] {
  const weights = Array.from({ length: GRID * GRID }, (_, index) => DISTRICT_WEIGHT[districtAt(index)]);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => (population * weight) / total);
  const counts = exact.map(Math.floor);
  let remaining = population - counts.reduce((sum, count) => sum + count, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (remaining <= 0) break;
    counts[index]!++;
    remaining--;
  }
  return counts;
}

export function grovesPerPark(population: number): number {
  return Math.round(population / 64) + 6;
}

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const TILE_MARGIN = 0.55;

/** Binary space partition: split the largest leaf along its longer side until `count` lots. */
export function splitLots(count: number, seed: number): Rect[] {
  const half = TILE_SIZE / 2 - TILE_MARGIN;
  const leaves: Rect[] = [{ x0: -half, z0: -half, x1: half, z1: half }];
  while (leaves.length < count) {
    let largest = 0;
    let largestArea = -1;
    for (let index = 0; index < leaves.length; index++) {
      const leaf = leaves[index]!;
      const area = (leaf.x1 - leaf.x0) * (leaf.z1 - leaf.z0);
      if (area > largestArea + 1e-9) {
        largest = index;
        largestArea = area;
      }
    }
    const leaf = leaves[largest]!;
    const ratio = 0.38 + 0.24 * hashUnit(seed, leaves.length);
    const width = leaf.x1 - leaf.x0;
    const depth = leaf.z1 - leaf.z0;
    if (width >= depth) {
      const cut = leaf.x0 + width * ratio;
      leaves.splice(largest, 1, { ...leaf, x1: cut }, { ...leaf, x0: cut });
    } else {
      const cut = leaf.z0 + depth * ratio;
      leaves.splice(largest, 1, { ...leaf, z1: cut }, { ...leaf, z0: cut });
    }
  }
  return leaves;
}

export function planCity(population: number): CityPlan {
  const perTile = buildingsPerTile(population);
  const used = new Map<District, number>();
  const neighborhoods = Array.from({ length: GRID * GRID }, (_, index): NeighborhoodPlan => {
    const district = districtAt(index);
    const occupied = district === "park" ? grovesPerPark(population) : perTile[index]!;
    const vacantCount = district === "park" ? Math.floor(occupied * 0.15) + 1 : Math.floor(occupied * 0.08) + 1;
    const seed = hashU32(index * 7919 + population);
    const rects = splitLots(occupied + vacantCount, seed);
    // The lots nearest the tile center stay empty and read as a plaza.
    const byCenter = rects
      .map((rect, lot) => ({ lot, distance: Math.hypot((rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2) }))
      .sort((a, b) => a.distance - b.distance || a.lot - b.lot);
    const vacant = new Set(byCenter.slice(0, vacantCount).map(({ lot }) => lot));
    const lots = rects.map((rect, lot): Lot => ({
      index: lot,
      x: (rect.x0 + rect.x1) / 2,
      z: (rect.z0 + rect.z1) / 2,
      width: rect.x1 - rect.x0,
      depth: rect.z1 - rect.z0,
      seed: hashU32(seed ^ hashU32(lot + 1)),
      vacant: vacant.has(lot),
    }));
    const nameIndex = used.get(district) ?? 0;
    used.set(district, nameIndex + 1);
    return { index, district, name: NAMES[district][nameIndex]!, center: tileCenter(index), lots };
  });
  return { population, neighborhoods };
}

const ALLEY = 0.14;

function pick<T>(values: readonly T[], unit: number): T {
  return values[Math.min(values.length - 1, Math.floor(unit * values.length))]!;
}

function box(
  paint: boolean,
  material: number,
  facade: number,
  position: [number, number, number],
  scale: [number, number, number],
  color = STONE_COLOR
): PartDesign {
  return { mesh: "box", paint, material, facade, position, scale, color };
}

/** The building on a lot; a pure function of the district, lot and its tile position. */
export function designBuilding(district: District, lot: Lot, tile: readonly [number, number]): BuildingDesign {
  const r = (salt: number) => hashUnit(lot.seed, salt);
  const width = Math.max(0.3, lot.width - ALLEY * 2);
  const depth = Math.max(0.3, lot.depth - ALLEY * 2);

  if (district === "park") return designGrove(width, depth, r);

  if (district === "oldtown" && r(1) > 0.18) {
    const w = Math.min(width, 2.1);
    const d = Math.min(depth, 2.1);
    const floors = 1 + Math.floor(r(2) * 3);
    const height = Math.min(floors * FLOOR_HEIGHT, Math.min(w, d) * 1.7 + 0.2);
    const roofHeight = 0.18 + Math.min(w, d) * 0.32;
    const swatch = pick([SWATCH.ivory, SWATCH.sand, SWATCH.ochre, SWATCH.rose, SWATCH.ivory], r(3));
    const parts: PartDesign[] = [
      box(true, MATERIAL.facade, FACADE.house, [0, height / 2, 0], [w, height, d]),
      {
        mesh: "roof",
        paint: false,
        material: MATERIAL.roof,
        facade: 0,
        position: [0, height + roofHeight / 2, 0],
        scale: [w * 1.08, roofHeight, d * 1.08],
        color: pick(ROOF_COLORS, r(4)),
      },
    ];
    if (r(5) > 0.55) {
      const side = r(6) > 0.5 ? 1 : -1;
      parts.push(
        box(false, MATERIAL.plain, 0, [side * w * 0.28, height + roofHeight * 0.6, d * 0.18], [0.13, roofHeight * 0.9 + 0.2, 0.13], "#a65a3c")
      );
    }
    return { kind: "house", swatch, parts };
  }

  if (district === "oldtown" || district === "midtown") {
    const w = Math.min(width, 3.4);
    const d = Math.min(depth, 3.4);
    const base = district === "oldtown" ? 3 : 3 + Math.floor(r(2) * 6);
    const height = Math.min(base * FLOOR_HEIGHT, Math.min(w, d) * 3 + 0.4);
    const swatch =
      district === "oldtown"
        ? pick([SWATCH.terracotta, SWATCH.ochre, SWATCH.sand], r(3))
        : pick([SWATCH.ivory, SWATCH.sand, SWATCH.terracotta, SWATCH.ivory, SWATCH.sage], r(3));
    const facade = r(7) > 0.5 ? FACADE.ribbon : FACADE.punched;
    const parts: PartDesign[] = [box(true, MATERIAL.facade, facade, [0, height / 2, 0], [w, height, d])];
    const unitW = w * (0.3 + r(8) * 0.2);
    const unitD = d * (0.25 + r(9) * 0.2);
    parts.push(
      box(false, MATERIAL.plain, 0, [(r(10) - 0.5) * (w - unitW) * 0.8, height + 0.12, (r(11) - 0.5) * (d - unitD) * 0.8], [unitW, 0.24, unitD], DARK_ROOF_COLOR)
    );
    return { kind: "midrise", swatch, parts };
  }

  // Downtown towers grow toward the city center.
  const w = Math.min(width, 3.2);
  const d = Math.min(depth, 3.2);
  const centerDistance = Math.hypot(tile[0] + lot.x, tile[1] + lot.z);
  const centrality = Math.max(0, 1 - centerDistance / (TILE_PITCH * 1.6));
  const floors = 7 + Math.floor((6 + centrality * 22) * (0.45 + r(2) * 0.55));
  const glass = r(3) < 0.28;
  const swatch = glass ? SWATCH.teal : pick([SWATCH.ivory, SWATCH.sand, SWATCH.ivory, SWATCH.terracotta], r(4));
  const height = Math.min(floors * FLOOR_HEIGHT, Math.min(w, d) * 6.5 + 0.8);
  const podium = Math.min(height * 0.3, FLOOR_HEIGHT * 2);
  const inset = 0.72 + r(5) * 0.16;
  const shaftW = w * inset;
  const shaftD = d * inset;
  const shaftHeight = height - podium;
  const parts: PartDesign[] = [
    box(false, MATERIAL.facade, FACADE.storefront, [0, podium / 2, 0], [w, podium, d], STONE_COLOR),
    box(true, glass ? MATERIAL.glass : MATERIAL.facade, glass ? FACADE.ribbon : FACADE.punched, [0, podium + shaftHeight / 2, 0], [shaftW, shaftHeight, shaftD]),
  ];
  if (r(6) > 0.35) {
    const crown = 0.3 + r(7) * 0.4;
    parts.push(
      box(true, MATERIAL.plain, 0, [0, height + crown / 2, 0], [shaftW * 0.6, crown, shaftD * 0.6])
    );
  }
  return { kind: "tower", swatch, parts };
}

function designGrove(width: number, depth: number, r: (salt: number) => number): BuildingDesign {
  const parts: PartDesign[] = [];
  const trees = 2 + Math.floor(r(1) * 3);
  for (let tree = 0; tree < trees; tree++) {
    const radius = 0.32 + r(10 + tree) * 0.32;
    const x = (r(20 + tree) - 0.5) * Math.max(0, width - radius * 2);
    const z = (r(30 + tree) - 0.5) * Math.max(0, depth - radius * 2);
    const trunk = 0.25 + r(40 + tree) * 0.3;
    parts.push(box(false, MATERIAL.trunk, 0, [x, trunk / 2, z], [0.09, trunk, 0.09], TRUNK_COLOR));
    parts.push({
      mesh: "tree",
      paint: false,
      material: MATERIAL.foliage,
      facade: 0,
      position: [x, trunk + radius * 0.9, z],
      scale: [radius * 2, radius * 2.3, radius * 2],
      color: pick(FOLIAGE_COLORS, r(50 + tree)),
    });
  }
  return { kind: "grove", swatch: SWATCH.sage, parts };
}

export interface PartTotals {
  box: number;
  roof: number;
  tree: number;
}

/** Records needed when every lot (vacant ones included) holds its building, plus one slab per tile. */
export function planCapacity(plan: CityPlan): PartTotals {
  const totals: PartTotals = { box: plan.neighborhoods.length, roof: 0, tree: 0 };
  for (const neighborhood of plan.neighborhoods) {
    for (const lot of neighborhood.lots) {
      for (const part of designBuilding(neighborhood.district, lot, neighborhood.center).parts) {
        totals[part.mesh]++;
      }
    }
  }
  return totals;
}

/** Fixed collection capacity covering every population preset. */
export function maxCapacity(): PartTotals {
  const totals: PartTotals = { box: 0, roof: 0, tree: 0 };
  for (const population of POPULATIONS) {
    const capacity = planCapacity(planCity(population));
    totals.box = Math.max(totals.box, capacity.box);
    totals.roof = Math.max(totals.roof, capacity.roof);
    totals.tree = Math.max(totals.tree, capacity.tree);
  }
  return totals;
}
