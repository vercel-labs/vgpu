import { normalized, pushVertex, toFlatTriangles, type StandardData } from "./primitive-data-utils.ts";

export interface IcosphereDataSpec {
  readonly radius: number;
  readonly subdivisions: number;
  readonly shading: "flat" | "smooth";
}

const T = (1 + Math.sqrt(5)) / 2;
const SEED: readonly (readonly [number, number, number])[] = [
  [-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0],
  [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T],
  [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1],
];
const FACES: readonly (readonly [number, number, number])[] = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

export function icosphereData(spec: IcosphereDataSpec): StandardData {
  const positions = SEED.map((p) => {
    const n = normalized(p[0], p[1], p[2]);
    return [n[0], n[1], n[2]] as [number, number, number];
  });
  let faces = FACES.map((face) => [...face] as [number, number, number]);
  for (let i = 0; i < spec.subdivisions; i++) faces = subdivide(positions, faces);

  const vertices: number[] = [];
  for (const p of positions) {
    const u = Math.atan2(p[2], p[0]) / (Math.PI * 2) + 0.5;
    const v = Math.asin(p[1]) / Math.PI + 0.5;
    pushVertex(vertices, p[0] * spec.radius, p[1] * spec.radius, p[2] * spec.radius, p[0], p[1], p[2], u, v);
  }
  const indices = faces.flat();
  const smooth: StandardData = { vertices: new Float32Array(vertices), indices: new Uint16Array(indices), vertexCount: positions.length };
  return spec.shading === "flat" ? toFlatTriangles(smooth) : smooth;
}

function subdivide(positions: [number, number, number][], faces: readonly (readonly [number, number, number])[]): [number, number, number][] {
  const next: [number, number, number][] = [];
  const midpointCache = new Map<string, number>();
  for (const [a, b, c] of faces) {
    const ab = midpoint(positions, midpointCache, a, b);
    const bc = midpoint(positions, midpointCache, b, c);
    const ca = midpoint(positions, midpointCache, c, a);
    next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  return next;
}

function midpoint(positions: [number, number, number][], cache: Map<string, number>, a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const key = `${lo}|${hi}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pa = positions[a]!;
  const pb = positions[b]!;
  const p = normalized(pa[0] + pb[0], pa[1] + pb[1], pa[2] + pb[2]);
  const index = positions.length;
  positions.push([p[0], p[1], p[2]]);
  cache.set(key, index);
  return index;
}
