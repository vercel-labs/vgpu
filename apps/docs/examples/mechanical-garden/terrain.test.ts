import { mulberry32 } from "math/random";
import { describe, expect, it } from "vitest";

import {
  CELL,
  CELLS,
  createTerrain,
  generate,
  GRID,
  HALF,
  heightAt,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_HEIGHT,
  normalAt,
  raycast,
  sculpt,
  uploadTerrain,
  VERTEX_FLOATS,
  writeVertices,
  type Terrain,
} from "./terrain";

/**
 * Independent oracle: intersect a vertical line with the triangles the app actually emits
 * (vertex positions + index buffer), with no knowledge of how the query picks a triangle.
 */
function oracleHeight(terrain: Terrain, x: number, z: number): number {
  const v = terrain.vertices;
  const idx = terrain.indices;
  const i = Math.min(CELLS - 1, Math.max(0, Math.floor((x + HALF) / CELL)));
  const j = Math.min(CELLS - 1, Math.max(0, Math.floor((z + HALF) / CELL)));
  const firstTri = (j * CELLS + i) * 2;
  for (let t = firstTri; t < firstTri + 2; t++) {
    const p = [0, 1, 2].map((c) => {
      const k = idx[t * 3 + c]! * VERTEX_FLOATS;
      return [v[k]!, v[k + 1]!, v[k + 2]!] as const;
    });
    const [p0, p1, p2] = p as [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
    // Barycentric coordinates in the XZ projection.
    const det = (p1[0] - p0[0]) * (p2[2] - p0[2]) - (p2[0] - p0[0]) * (p1[2] - p0[2]);
    const l1 = ((x - p0[0]) * (p2[2] - p0[2]) - (p2[0] - p0[0]) * (z - p0[2])) / det;
    const l2 = ((p1[0] - p0[0]) * (z - p0[2]) - (x - p0[0]) * (p1[2] - p0[2])) / det;
    const l0 = 1 - l1 - l2;
    if (l0 >= -1e-9 && l1 >= -1e-9 && l2 >= -1e-9) return l0 * p0[1] + l1 * p1[1] + l2 * p2[1];
  }
  throw new Error(`no triangle under ${x}, ${z}`);
}

function flatTerrain(): Terrain {
  const terrain = createTerrain(1);
  terrain.heights.fill(0);
  terrain.dirty = { i0: 0, j0: 0, i1: CELLS, j1: CELLS };
  writeVertices(terrain);
  return terrain;
}

describe("terrain query agrees with the emitted mesh", () => {
  it("splits each cell along the emitted diagonal, not bilinearly", () => {
    const terrain = flatTerrain();
    const i = 40;
    const j = 52;
    const gamma = Math.fround(0.04); // heights are float32
    // h = γ·i·j on the cell's corners in local coordinates: only the (1,1) corner is raised.
    terrain.heights[(j + 1) * GRID + (i + 1)] = gamma;
    terrain.dirty = { i0: i, j0: j, i1: i + 1, j1: j + 1 };
    writeVertices(terrain);
    const cx = -HALF + (i + 0.5) * CELL;
    const cz = -HALF + (j + 0.5) * CELL;
    expect(heightAt(terrain, cx, cz)).toBeCloseTo(0, 12); // bilinear would give γ/4
    expect(oracleHeight(terrain, cx, cz)).toBeCloseTo(0, 12);
    // Face normal of the raised triangle (b, c, d) = normalize(cross(c − b, d − b)) for CCW-from-above winding.
    const b = [cx + CELL / 2, 0, cz - CELL / 2];
    const c = [cx - CELL / 2, 0, cz + CELL / 2];
    const d = [cx + CELL / 2, gamma, cz + CELL / 2];
    const e1 = [c[0]! - b[0]!, c[1]! - b[1]!, c[2]! - b[2]!];
    const e2 = [d[0]! - b[0]!, d[1]! - b[1]!, d[2]! - b[2]!];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!);
    const got = normalAt([0, 0, 0], terrain, cx + CELL * 0.3, cz + CELL * 0.3);
    expect(got[0]).toBeCloseTo(n[0]! / l, 12);
    expect(got[1]).toBeCloseTo(n[1]! / l, 12);
    expect(got[2]).toBeCloseTo(n[2]! / l, 12);
    expect(n[1]).toBeGreaterThan(0);
  });

  it("matches the oracle at 1000 seeded points after generation and edits", () => {
    const terrain = createTerrain(7);
    for (let k = 0; k < 90; k++) sculpt(terrain, { x: 0.8, z: -0.6, radius: 1.1, rate: 0.6 }, 1 / 60);
    for (let k = 0; k < 40; k++) sculpt(terrain, { x: -1.5, z: 1.2, radius: 0.8, rate: -0.6 }, 1 / 60);
    writeVertices(terrain);
    const random = mulberry32.create(99);
    for (let k = 0; k < 1000; k++) {
      const x = (mulberry32.sample(random) * 2 - 1) * HALF * 0.999;
      const z = (mulberry32.sample(random) * 2 - 1) * HALF * 0.999;
      expect(Math.abs(heightAt(terrain, x, z) - oracleHeight(terrain, x, z))).toBeLessThan(1e-6);
    }
  });

  it("is deterministic for a seed and differs between seeds", () => {
    expect(createTerrain(3).heights).toEqual(createTerrain(3).heights);
    expect(createTerrain(3).heights).not.toEqual(createTerrain(4).heights);
  });
});

describe("bounded sculpting", () => {
  function maxNeighbourStep(terrain: Terrain): number {
    let worst = 0;
    const h = terrain.heights;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        if (i < CELLS) worst = Math.max(worst, Math.abs(h[k + 1]! - h[k]!));
        if (j < CELLS) worst = Math.max(worst, Math.abs(h[k + GRID]! - h[k]!));
      }
    }
    return worst;
  }

  it("keeps the slope and range bounds through long raises and lowers", () => {
    const terrain = createTerrain(11);
    expect(maxNeighbourStep(terrain)).toBeLessThanOrEqual(MAX_STEP + 1e-6);
    for (let k = 0; k < 900; k++) sculpt(terrain, { x: 0.3, z: 0.2, radius: 0.5, rate: 0.6 }, 1 / 60);
    for (let k = 0; k < 900; k++) sculpt(terrain, { x: -2, z: -1.7, radius: 1.6, rate: -0.6 }, 1 / 60);
    expect(maxNeighbourStep(terrain)).toBeLessThanOrEqual(MAX_STEP + 1e-6);
    const heights = [...terrain.heights];
    expect(Math.max(...heights)).toBeLessThanOrEqual(MAX_HEIGHT + 1e-6);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(MIN_HEIGHT - 1e-6);
    // The rim stays pinned so the tile edge meets the plinth.
    expect(terrain.heights[0]).toBe(0);
    expect(terrain.heights[GRID * 48 + 1]).toBe(0);
  });

  it("changes height by at most rate·dt per step and marks only the brushed rows dirty", () => {
    const terrain = flatTerrain();
    const before = Float32Array.from(terrain.heights);
    expect(sculpt(terrain, { x: 1, z: 1, radius: 0.6, rate: 0.6 }, 1 / 60)).toBe(true);
    let worst = 0;
    for (let k = 0; k < before.length; k++) worst = Math.max(worst, Math.abs(terrain.heights[k]! - before[k]!));
    expect(worst).toBeLessThanOrEqual(0.6 / 60 + 1e-7);
    const range = writeVertices(terrain)!;
    expect(range.row0).toBeGreaterThan(0);
    expect(range.row1).toBeLessThan(CELLS);
    expect(range.row1 - range.row0).toBeLessThanOrEqual(Math.ceil((2 * 0.6) / CELL) + 6);
  });

  it("ignores non-finite brushes and clamps radius and rate", () => {
    const terrain = flatTerrain();
    expect(sculpt(terrain, { x: Number.NaN, z: 0, radius: 1, rate: 1 }, 1 / 60)).toBe(false);
    sculpt(terrain, { x: 0, z: 0, radius: 100, rate: 100 }, 1 / 60);
    const heights = [...terrain.heights];
    expect(Math.max(...heights)).toBeLessThanOrEqual(0.6 / 15 + 1e-6);
    // Radius clamps to 1.6: a point 2 units from the centre is untouched.
    expect(heightAt(terrain, 2, 0)).toBe(0);
  });
});

/** Independent oracle: Möller–Trumbore against every emitted triangle, keeping the nearest t > 0. */
function bruteForce(terrain: Terrain, origin: readonly number[], direction: readonly number[]): [number, number, number] | null {
  const v = terrain.vertices;
  const idx = terrain.indices;
  const point = (n: number) => [v[n * VERTEX_FLOATS]!, v[n * VERTEX_FLOATS + 1]!, v[n * VERTEX_FLOATS + 2]!];
  let best = Infinity;
  for (let t = 0; t < idx.length; t += 3) {
    const a = point(idx[t]!);
    const b = point(idx[t + 1]!);
    const c = point(idx[t + 2]!);
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const p = [direction[1]! * e2[2]! - direction[2]! * e2[1]!, direction[2]! * e2[0]! - direction[0]! * e2[2]!, direction[0]! * e2[1]! - direction[1]! * e2[0]!];
    const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!;
    if (Math.abs(det) < 1e-18) continue;
    const s = [origin[0]! - a[0]!, origin[1]! - a[1]!, origin[2]! - a[2]!];
    const u = (s[0]! * p[0]! + s[1]! * p[1]! + s[2]! * p[2]!) / det;
    if (u < -1e-12 || u > 1 + 1e-12) continue;
    const q = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
    const w = (direction[0]! * q[0]! + direction[1]! * q[1]! + direction[2]! * q[2]!) / det;
    if (w < -1e-12 || u + w > 1 + 1e-12) continue;
    const distance = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det;
    if (distance > 0 && distance < best) best = distance;
  }
  if (!Number.isFinite(best)) return null;
  return [origin[0]! + direction[0]! * best, origin[1]! + direction[1]! * best, origin[2]! + direction[2]! * best];
}

describe("raycast", () => {
  it("hits the exact surface from an oblique camera ray", () => {
    const terrain = createTerrain(5);
    const origin: [number, number, number] = [6, 7, 5];
    const aim: [number, number, number] = [0.5, heightAt(terrain, 0.5, -0.4), -0.4];
    const hit = raycast(terrain, origin, [aim[0] - origin[0], aim[1] - origin[1], aim[2] - origin[2]], [0, 0, 0]);
    expect(hit).not.toBeNull();
    expect(Math.abs(hit![1] - heightAt(terrain, hit![0], hit![2]))).toBeLessThan(1e-9);
    expect(Math.hypot(hit![0] - aim[0], hit![2] - aim[2])).toBeLessThan(0.05);
  });

  it("catches a grazing ray that crosses a one-vertex crest between samples", () => {
    // Lead reproduction MG-L1: a single raised vertex, a nearly horizontal ray just under its apex.
    const terrain = flatTerrain();
    const mid = CELLS / 2;
    terrain.heights[mid * GRID + mid] = 0.04;
    terrain.dirty = { i0: 0, j0: 0, i1: CELLS, j1: CELLS };
    writeVertices(terrain);
    for (let slope = 0.001; slope < 0.5; slope += 0.007) {
      const origin: [number, number, number] = [-5, 0.03999, -5 * slope];
      const direction: [number, number, number] = [1, 0, slope];
      const hit = raycast(terrain, origin, direction, [0, 0, 0]);
      const expected = bruteForce(terrain, origin, direction);
      expect(expected).not.toBeNull();
      expect(hit).not.toBeNull();
      expect(Math.hypot(hit![0] - expected![0], hit![1] - expected![1], hit![2] - expected![2])).toBeLessThan(1e-9);
    }
  });

  it("returns the closest triangle hit for seeded rays, matching a brute-force scan", () => {
    const terrain = createTerrain(13);
    for (let k = 0; k < 120; k++) sculpt(terrain, { x: 0.4, z: 0.1, radius: 0.9, rate: 0.6 }, 1 / 60);
    writeVertices(terrain);
    const random = mulberry32.create(5);
    const r = () => mulberry32.sample(random);
    for (let k = 0; k < 40; k++) {
      // Oblique, grazing and diagonal rays from outside and above the tile.
      const angle = r() * Math.PI * 2;
      const origin: [number, number, number] = [Math.cos(angle) * 6, 0.05 + r() * 3, Math.sin(angle) * 6];
      const aim: [number, number, number] = [(r() - 0.5) * 6, r() * 0.3 - 0.1, (r() - 0.5) * 6];
      const direction: [number, number, number] = [aim[0] - origin[0], aim[1] - origin[1], aim[2] - origin[2]];
      const hit = raycast(terrain, origin, direction, [0, 0, 0]);
      const expected = bruteForce(terrain, origin, direction);
      if (expected === null) {
        expect(hit).toBeNull();
        continue;
      }
      expect(hit).not.toBeNull();
      expect(Math.hypot(hit![0] - expected[0], hit![1] - expected[1], hit![2] - expected[2])).toBeLessThan(1e-7);
    }
  });

  it("misses rays that never cross the tile", () => {
    const terrain = createTerrain(5);
    expect(raycast(terrain, [0, 5, 0], [0, 1, 0], [0, 0, 0])).toBeNull();
    expect(raycast(terrain, [20, 1, 0], [1, 0, 0], [0, 0, 0])).toBeNull();
    expect(raycast(terrain, [0, 5, 0], [Number.NaN, -1, 0], [0, 0, 0])).toBeNull();
  });
});

describe("GPU upload", () => {
  /** A geometry double that keeps a GPU-side copy and the vertex rows each write covered. */
  function recordingSink(initial: Float32Array) {
    const gpuCopy = new Float32Array(initial);
    const rows: Array<[number, number]> = [];
    return {
      gpuCopy,
      rows,
      write(data: Float32Array, byteOffset = 0) {
        const first = byteOffset / 4;
        gpuCopy.set(data, first);
        rows.push([first / (GRID * VERTEX_FLOATS), (first + data.length) / (GRID * VERTEX_FLOATS) - 1]);
      },
    };
  }

  it("a re-seed uploads every vertex even when a sculpt dirtied a few rows before the sync", () => {
    const terrain = createTerrain(3);
    const sink = recordingSink(terrain.vertices);
    const uploaded = { generation: terrain.generation };

    generate(terrain, 11);
    expect(sculpt(terrain, { x: 0.4, z: -0.6, radius: 0.5, rate: 0.6 }, 1 / 60)).toBe(true);
    expect(terrain.dirty).not.toBeNull();
    expect(uploadTerrain(terrain, sink, uploaded)).toBe(terrain.vertices.byteLength);

    expect(sink.rows).toEqual([[0, CELLS]]);
    expect(sink.gpuCopy).toEqual(terrain.vertices);
    // The GPU mesh carries the CPU heights everywhere, not only near the sculpt.
    for (let k = 0; k < GRID * GRID; k++) expect(sink.gpuCopy[k * VERTEX_FLOATS + 1]).toBe(terrain.heights[k]);
  });

  it("a sculpt alone uploads only its rows, and a clean terrain uploads nothing", () => {
    const terrain = createTerrain(3);
    const sink = recordingSink(terrain.vertices);
    const uploaded = { generation: terrain.generation };

    expect(uploadTerrain(terrain, sink, uploaded)).toBe(0);
    expect(sink.rows).toEqual([]);

    sculpt(terrain, { x: 0, z: 0, radius: 0.4, rate: 0.6 }, 1 / 60);
    const bytes = uploadTerrain(terrain, sink, uploaded);
    expect(sink.rows).toHaveLength(1);
    const [row0, row1] = sink.rows[0]!;
    expect(bytes).toBe((row1 - row0 + 1) * GRID * VERTEX_FLOATS * 4);
    expect(row0).toBeGreaterThan(0);
    expect(row1).toBeLessThan(CELLS);
    expect(sink.gpuCopy).toEqual(terrain.vertices);

    // Two generations in a row still upload once, in full.
    generate(terrain, 5);
    generate(terrain, 6);
    uploadTerrain(terrain, sink, uploaded);
    expect(sink.rows.at(-1)).toEqual([0, CELLS]);
    expect(sink.rows).toHaveLength(2);
    expect(sink.gpuCopy).toEqual(terrain.vertices);
  });
});
