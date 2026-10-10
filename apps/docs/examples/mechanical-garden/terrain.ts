// The sculptable training-ground tile. One CPU height grid is the only source of truth: its samples are the
// mesh vertices, the index buffer splits every cell along the same diagonal the query uses, and the
// shader only reads the uploaded heights. Edits are bounded (rate, range and neighbour slope), so
// planted feet can follow them without leaving the leg's reach band.
// DOM-free: the renderer, the thumbnail and the tests drive it directly.

import { clamp, type Vec3 } from "math";
import { mulberry32 } from "math/random";
import { fbm, simplex2d } from "math/noise";
import { raycast3 } from "math/shapes";

/** Tile edge length in world units; the tile spans [-HALF, HALF] on x and z. */
export const TILE_SIZE = 15;
export const HALF = TILE_SIZE / 2;
/** Cells per side; GRID = CELLS + 1 vertices per side. */
export const CELLS = 160;
export const GRID = CELLS + 1;
export const CELL = TILE_SIZE / CELLS;
/** Height bounds. The tile top is y = 0 at the rim. */
export const MIN_HEIGHT = -0.3;
export const MAX_HEIGHT = 0.85;
/** Steepest allowed neighbour slope, in radians. */
export const MAX_SLOPE = (26 * Math.PI) / 180;
/** Largest allowed height difference between 4-neighbours. */
export const MAX_STEP = Math.tan(MAX_SLOPE) * CELL;
/** Cells along the rim that stay pinned at height 0 (the glaze lip). */
export const RIM_CELLS = 3;
/** Brush bounds. Strength is in world units per second at the brush centre. */
export const BRUSH_RADIUS = { min: 0.3, max: 1.6 } as const;
export const BRUSH_STRENGTH = { min: 0.05, max: 0.6 } as const;

/** Floats per vertex: position (3), normal (3), cavity (1). */
export const VERTEX_FLOATS = 7;
export const VERTEX_BYTES = VERTEX_FLOATS * 4;

export interface DirtyRect {
  i0: number;
  j0: number;
  i1: number;
  j1: number;
}

export interface Terrain {
  /** Height per vertex, row-major by z (index = j * GRID + i). float32 so CPU and GPU agree. */
  readonly heights: Float32Array;
  /** Interleaved vertex data uploaded to the GPU. */
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
  /** Bumped on every edit that changed a height. */
  revision: number;
  /** Bumped by generate(): every vertex changed, so the next GPU upload must cover the whole mesh. */
  generation: number;
  /** Vertex rows that must be re-uploaded (normals and cavity included), or null. */
  dirty: DirtyRect | null;
}

export function createTerrain(seed: number): Terrain {
  const terrain: Terrain = {
    heights: new Float32Array(GRID * GRID),
    vertices: new Float32Array(GRID * GRID * VERTEX_FLOATS),
    indices: buildIndices(),
    revision: 0,
    generation: 0,
    dirty: null,
  };
  generate(terrain, seed);
  return terrain;
}

/** Re-seed the relief in place (deterministic for a seed); marks the whole grid dirty. */
export function generate(terrain: Terrain, seed: number): void {
  const random = mulberry32.create(seed >>> 0);
  const noise = simplex2d.create(Math.floor(mulberry32.sample(random) * 0x7fffffff));
  const ox = mulberry32.sample(random) * 64;
  const oz = mulberry32.sample(random) * 64;
  const { heights } = terrain;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = gridX(i);
      const z = gridX(j);
      const n = fbm((f) => simplex2d.sample(noise, (x + ox) * 0.2 * f, (z + oz) * 0.2 * f), 3, 2.03, 0.45);
      // A graded training ground: a low berm to the north-east, a shallow dip to the south-west and
      // a faint unevenness, so the default walk already shows the body pitching over relief.
      const berm = 0.2 * Math.exp(-((x - 1.7) ** 2 + (z + 1.4) ** 2) / 3.2);
      const dip = -0.12 * Math.exp(-((x + 1.6) ** 2 + (z - 1.5) ** 2) / 2.4);
      heights[j * GRID + i] = rimMask(i, j) * (0.08 * n + berm + dip);
    }
  }
  relaxAll(heights);
  terrain.revision++;
  terrain.generation++;
  terrain.dirty = { i0: 0, j0: 0, i1: CELLS, j1: CELLS };
  writeVertices(terrain);
}

export function gridX(i: number): number {
  return -HALF + i * CELL;
}

/** 0 on the pinned rim, easing to 1 about 0.7 units in. */
function rimMask(i: number, j: number): number {
  const edge = Math.min(i, j, CELLS - i, CELLS - j) - RIM_CELLS;
  if (edge <= 0) return 0;
  const t = Math.min(1, (edge * CELL) / 0.7);
  return t * t * (3 - 2 * t);
}

export function isPinned(i: number, j: number): boolean {
  return Math.min(i, j, CELLS - i, CELLS - j) <= RIM_CELLS;
}

function buildIndices(): Uint32Array<ArrayBuffer> {
  const indices = new Uint32Array(CELLS * CELLS * 6);
  let k = 0;
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const a = j * GRID + i;
      const b = a + 1;
      const c = a + GRID;
      const d = c + 1;
      // Counter-clockwise seen from +Y; the b–c diagonal matches heightAt().
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  return indices;
}

/** Clamp a world point onto the tile, keeping `margin` from the edge. */
export function clampToTile(value: number, margin = 0): number {
  return clamp(value, -HALF + margin, HALF - margin);
}

/** Exact height of the drawn surface at (x, z); points off the tile are clamped onto it. */
export function heightAt(terrain: Terrain, x: number, z: number): number {
  const gx = clamp((x + HALF) / CELL, 0, CELLS);
  const gz = clamp((z + HALF) / CELL, 0, CELLS);
  const i = Math.min(CELLS - 1, Math.floor(gx));
  const j = Math.min(CELLS - 1, Math.floor(gz));
  const u = gx - i;
  const v = gz - j;
  const h = terrain.heights;
  const a = j * GRID + i;
  const hb = h[a + 1]!;
  const hc = h[a + GRID]!;
  if (u + v <= 1) {
    const ha = h[a]!;
    return ha + (hb - ha) * u + (hc - ha) * v;
  }
  const hd = h[a + GRID + 1]!;
  return hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - v);
}

/** Unit face normal of the triangle under (x, z), written into `out`. */
export function normalAt(out: [number, number, number], terrain: Terrain, x: number, z: number): [number, number, number] {
  const gx = clamp((x + HALF) / CELL, 0, CELLS);
  const gz = clamp((z + HALF) / CELL, 0, CELLS);
  const i = Math.min(CELLS - 1, Math.floor(gx));
  const j = Math.min(CELLS - 1, Math.floor(gz));
  const h = terrain.heights;
  const a = j * GRID + i;
  const hb = h[a + 1]!;
  const hc = h[a + GRID]!;
  let dx: number;
  let dz: number;
  if (gx - i + (gz - j) <= 1) {
    const ha = h[a]!;
    dx = (hb - ha) / CELL;
    dz = (hc - ha) / CELL;
  } else {
    const hd = h[a + GRID + 1]!;
    dx = (hd - hc) / CELL;
    dz = (hd - hb) / CELL;
  }
  const inv = 1 / Math.hypot(dx, 1, dz);
  out[0] = -dx * inv;
  out[1] = inv;
  out[2] = -dz * inv;
  return out;
}

export interface Brush {
  x: number;
  z: number;
  radius: number;
  /** World units per second at the centre; negative lowers. */
  rate: number;
}

/**
 * Raise or lower the tile under a brush for `dt` seconds with a (1 − r²)² falloff.
 * Each cell is clamped against its current neighbours, so the slope bound holds exactly after
 * every edit (raising saturates into a talus cone instead of a spike). Returns whether anything moved.
 */
export function sculpt(terrain: Terrain, brush: Brush, dt: number): boolean {
  const radius = clamp(brush.radius, BRUSH_RADIUS.min, BRUSH_RADIUS.max);
  const rate = clamp(brush.rate, -BRUSH_STRENGTH.max, BRUSH_STRENGTH.max);
  if (!(dt > 0) || rate === 0 || !Number.isFinite(brush.x) || !Number.isFinite(brush.z)) return false;
  const amount = rate * Math.min(dt, 1 / 15);
  const i0 = Math.max(RIM_CELLS + 1, Math.floor((brush.x - radius + HALF) / CELL));
  const i1 = Math.min(CELLS - RIM_CELLS - 1, Math.ceil((brush.x + radius + HALF) / CELL));
  const j0 = Math.max(RIM_CELLS + 1, Math.floor((brush.z - radius + HALF) / CELL));
  const j1 = Math.min(CELLS - RIM_CELLS - 1, Math.ceil((brush.z + radius + HALF) / CELL));
  if (i0 > i1 || j0 > j1) return false;
  const h = terrain.heights;
  const r2 = 1 / (radius * radius);
  let changed = false;
  // Raise from the centre outward is not needed: each update only ever tightens its own edges.
  for (let j = j0; j <= j1; j++) {
    const dz = gridX(j) - brush.z;
    for (let i = i0; i <= i1; i++) {
      const dx = gridX(i) - brush.x;
      const q = (dx * dx + dz * dz) * r2;
      if (q >= 1) continue;
      const w = (1 - q) * (1 - q);
      const k = j * GRID + i;
      const before = h[k]!;
      const left = h[k - 1]!;
      const right = h[k + 1]!;
      const down = h[k - GRID]!;
      const up = h[k + GRID]!;
      let next = before + amount * w;
      if (amount > 0) {
        next = Math.min(next, MAX_HEIGHT, Math.min(left, right, down, up) + MAX_STEP);
        next = Math.max(next, before);
      } else {
        next = Math.max(next, MIN_HEIGHT, Math.max(left, right, down, up) - MAX_STEP);
        next = Math.min(next, before);
      }
      // float32 storage: keep the stored value inside the bound after rounding.
      const stored = Math.fround(next);
      if (stored !== before) {
        h[k] = stored;
        changed = true;
      }
    }
  }
  if (!changed) return false;
  // Re-check the rounded values once; fround can overshoot a bound by one ulp.
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * GRID + i;
      const lo = Math.max(h[k - 1]!, h[k + 1]!, h[k - GRID]!, h[k + GRID]!) - MAX_STEP;
      const hi = Math.min(h[k - 1]!, h[k + 1]!, h[k - GRID]!, h[k + GRID]!) + MAX_STEP;
      if (h[k]! > hi) h[k] = Math.fround(hi);
      else if (h[k]! < lo) h[k] = Math.fround(lo);
    }
  }
  terrain.revision++;
  markDirty(terrain, i0, j0, i1, j1);
  return true;
}

function markDirty(terrain: Terrain, i0: number, j0: number, i1: number, j1: number): void {
  const d = terrain.dirty;
  if (!d) terrain.dirty = { i0, j0, i1, j1 };
  else {
    d.i0 = Math.min(d.i0, i0);
    d.j0 = Math.min(d.j0, j0);
    d.i1 = Math.max(d.i1, i1);
    d.j1 = Math.max(d.j1, j1);
  }
}

/** Pull every neighbour pair inside the slope bound (initial generation only). */
function relaxAll(h: Float32Array): void {
  for (let k = 0; k < h.length; k++) {
    h[k] = isPinned(k % GRID, Math.floor(k / GRID)) ? 0 : Math.fround(clamp(h[k]!, MIN_HEIGHT, MAX_HEIGHT));
  }
  const limit = MAX_STEP * 0.98;
  const fixPair = (k: number, n: number, pinnedK: boolean, pinnedN: boolean): number => {
    const diff = h[n]! - h[k]!;
    if (Math.abs(diff) <= limit || (pinnedK && pinnedN)) return 0;
    const excess = (Math.abs(diff) - limit) * Math.sign(diff);
    if (pinnedK) h[n] = Math.fround(h[n]! - excess);
    else if (pinnedN) h[k] = Math.fround(h[k]! + excess);
    else {
      h[k] = Math.fround(h[k]! + excess * 0.5);
      h[n] = Math.fround(h[n]! - excess * 0.5);
    }
    return 1;
  };
  for (let pass = 0; pass < 200; pass++) {
    let violations = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        const pinned = isPinned(i, j);
        if (i < CELLS) violations += fixPair(k, k + 1, pinned, isPinned(i + 1, j));
        if (j < CELLS) violations += fixPair(k, k + GRID, pinned, isPinned(i, j + 1));
      }
    }
    if (violations === 0) return;
  }
}

/**
 * Recompute positions, smooth normals and cavity for the dirty rows (plus the ring that reads
 * them). Returns the vertex row range written, or null when clean.
 */
export function writeVertices(terrain: Terrain): { row0: number; row1: number } | null {
  const d = terrain.dirty;
  if (!d) return null;
  terrain.dirty = null;
  const ring = 2;
  const i0 = Math.max(0, d.i0 - ring);
  const i1 = Math.min(CELLS, d.i1 + ring);
  const row0 = Math.max(0, d.j0 - ring);
  const row1 = Math.min(CELLS, d.j1 + ring);
  const h = terrain.heights;
  const v = terrain.vertices;
  const at = (i: number, j: number) => h[clamp(j, 0, CELLS) * GRID + clamp(i, 0, CELLS)]!;
  for (let j = row0; j <= row1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * GRID + i;
      const o = k * VERTEX_FLOATS;
      const y = h[k]!;
      const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * CELL);
      const dz = (at(i, j + 1) - at(i, j - 1)) / (2 * CELL);
      const inv = 1 / Math.hypot(dx, 1, dz);
      // Cavity: how far the vertex sits below the mean of a two-cell ring (glaze pools there).
      const ringMean =
        (at(i - 2, j) + at(i + 2, j) + at(i, j - 2) + at(i, j + 2) + at(i - 1, j - 1) + at(i + 1, j - 1) + at(i - 1, j + 1) + at(i + 1, j + 1)) / 8;
      v[o] = gridX(i);
      v[o + 1] = y;
      v[o + 2] = gridX(j);
      v[o + 3] = -dx * inv;
      v[o + 4] = inv;
      v[o + 5] = -dz * inv;
      v[o + 6] = clamp((ringMean - y) * 9, -1, 1);
    }
  }
  return { row0, row1 };
}

const rayOrigin: Vec3 = [0, 0, 0];
const rayDirection: Vec3 = [0, 0, 0];
const corners: [Vec3, Vec3, Vec3, Vec3] = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];
const triangleHit = raycast3.createIntersectsTriangleResult();

/**
 * Closest hit of a ray with the drawn triangles, or null. The ray walks the grid cells it crosses
 * in x/z order (a 2D DDA clipped to the height slab) and tests each cell's two emitted triangles
 * with math/shapes, so grazing rays that cross a crest between samples still hit.
 * `origin` and `direction` are world space; `direction` need not be normalized.
 */
export function raycast(
  terrain: Terrain,
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  out: [number, number, number],
): [number, number, number] | null {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(len > 0) || !Number.isFinite(len) || !origin.every(Number.isFinite)) return null;
  const dx = direction[0] / len;
  const dy = direction[1] / len;
  const dz = direction[2] / len;
  // Clip to the slab [-HALF, HALF]² × [MIN_HEIGHT, MAX_HEIGHT].
  let t0 = 0;
  let t1 = 1e4;
  const slab = (o: number, d: number, lo: number, hi: number) => {
    if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
    let a = (lo - o) / d;
    let b = (hi - o) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    return t0 <= t1;
  };
  const [ox, oy, oz] = origin;
  if (!slab(ox, dx, -HALF, HALF) || !slab(oz, dz, -HALF, HALF) || !slab(oy, dy, MIN_HEIGHT - 1e-3, MAX_HEIGHT + 1e-3)) return null;
  rayOrigin[0] = ox;
  rayOrigin[1] = oy;
  rayOrigin[2] = oz;
  rayDirection[0] = dx;
  rayDirection[1] = dy;
  rayDirection[2] = dz;
  // Grid DDA from the clipped entry point.
  const gx = clamp((ox + dx * t0 + HALF) / CELL, 0, CELLS);
  const gz = clamp((oz + dz * t0 + HALF) / CELL, 0, CELLS);
  let i = Math.min(CELLS - 1, Math.floor(gx));
  let j = Math.min(CELLS - 1, Math.floor(gz));
  const stepI = dx > 0 ? 1 : -1;
  const stepJ = dz > 0 ? 1 : -1;
  const deltaI = Math.abs(dx) > 1e-12 ? CELL / Math.abs(dx) : Infinity;
  const deltaJ = Math.abs(dz) > 1e-12 ? CELL / Math.abs(dz) : Infinity;
  let nextI = Math.abs(dx) > 1e-12 ? t0 + ((dx > 0 ? i + 1 - gx : gx - i) * CELL) / Math.abs(dx) : Infinity;
  let nextJ = Math.abs(dz) > 1e-12 ? t0 + ((dz > 0 ? j + 1 - gz : gz - j) * CELL) / Math.abs(dz) : Infinity;
  const h = terrain.heights;
  for (let visited = 0; visited <= 2 * CELLS + 2; visited++) {
    const best = cellHit(h, i, j, t1);
    if (best >= 0) {
      out[0] = ox + dx * best;
      out[1] = oy + dy * best;
      out[2] = oz + dz * best;
      return out;
    }
    const exit = Math.min(nextI, nextJ);
    if (exit > t1) return null;
    // Step into every cell the ray enters at this boundary (both when it crosses a corner).
    if (nextI <= nextJ) {
      i += stepI;
      nextI += deltaI;
    } else {
      j += stepJ;
      nextJ += deltaJ;
    }
    if (i < 0 || i >= CELLS || j < 0 || j >= CELLS) return null;
  }
  return null;
}

/** Nearest ray distance hitting either triangle of cell (i, j) within `limit`, or −1. */
function cellHit(h: Float32Array, i: number, j: number, limit: number): number {
  const [a, b, c, d] = corners;
  const k = j * GRID + i;
  a[0] = c[0] = gridX(i);
  b[0] = d[0] = gridX(i + 1);
  a[2] = b[2] = gridX(j);
  c[2] = d[2] = gridX(j + 1);
  a[1] = h[k]!;
  b[1] = h[k + 1]!;
  c[1] = h[k + GRID]!;
  d[1] = h[k + GRID + 1]!;
  let best = -1;
  // The same two triangles the index buffer emits: (a, c, b) and (b, c, d).
  raycast3.intersectsTriangle(triangleHit, rayOrigin, rayDirection, limit, a, c, b, false);
  if (triangleHit.hit) best = triangleHit.fraction * limit;
  raycast3.intersectsTriangle(triangleHit, rayOrigin, rayDirection, limit, b, c, d, false);
  if (triangleHit.hit && (best < 0 || triangleHit.fraction * limit < best)) best = triangleHit.fraction * limit;
  return best;
}

/** The slice of a vgpu geometry the terrain upload needs (byte offsets, like Geometry.write). */
export interface VertexSink {
  write(data: Float32Array<ArrayBuffer>, byteOffset?: number): void;
}

/**
 * Bring a GPU copy of the vertices up to date. A new generation (a reset/re-seed) uploads every
 * vertex even when a sculpt has since dirtied a few rows: generate() wrote the whole mesh on the
 * CPU and cleared `dirty`, so the dirty rows alone would leave the rest of the old relief on the GPU.
 * Returns the bytes written (0 when the GPU copy was already current).
 */
export function uploadTerrain(terrain: Terrain, sink: VertexSink, uploaded: { generation: number }): number {
  const rows = writeVertices(terrain);
  if (uploaded.generation !== terrain.generation) {
    sink.write(terrain.vertices);
    uploaded.generation = terrain.generation;
    return terrain.vertices.byteLength;
  }
  if (!rows) return 0;
  const first = rows.row0 * GRID * VERTEX_FLOATS;
  const last = (rows.row1 + 1) * GRID * VERTEX_FLOATS;
  sink.write(terrain.vertices.subarray(first, last), first * 4);
  return (last - first) * 4;
}
