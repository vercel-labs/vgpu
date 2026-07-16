import { normalized, pushVertex, type StandardData } from "./primitive-data-utils.ts";

export interface PolyhedronSeed {
  readonly vertices: ReadonlyArray<readonly [number, number, number]>;
  readonly faces: ReadonlyArray<ReadonlyArray<number>>;
}

export function polyhedronData(seed: PolyhedronSeed, radius: number): StandardData {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (const face of seed.faces) {
    for (let i = 1; i < face.length - 1; i++) {
      pushTriangle(vertices, indices, seed.vertices[face[0]!]!, seed.vertices[face[i]!]!, seed.vertices[face[i + 1]!]!, radius);
    }
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices), vertexCount: vertices.length / 8 };
}

function pushTriangle(out: number[], indices: number[], a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number], radius: number): void {
  let normal = faceNormal(a, b, c);
  let b2 = b;
  let c2 = c;
  if (dot(normal, center(a, b, c)) < 0) {
    b2 = c;
    c2 = b;
    normal = faceNormal(a, b2, c2);
  }
  const base = out.length / 8;
  pushVertex(out, a[0] * radius, a[1] * radius, a[2] * radius, normal[0], normal[1], normal[2], 0, 0);
  pushVertex(out, b2[0] * radius, b2[1] * radius, b2[2] * radius, normal[0], normal[1], normal[2], 1, 0);
  pushVertex(out, c2[0] * radius, c2[1] * radius, c2[2] * radius, normal[0], normal[1], normal[2], 0.5, 1);
  indices.push(base, base + 1, base + 2);
}

function faceNormal(a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number]): readonly [number, number, number] {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  return normalized(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
}

function center(a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number]): readonly [number, number, number] {
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
