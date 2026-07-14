import { normalized } from "./primitive-data-utils.ts";
import type { PolyhedronSeed } from "./polyhedron-data.ts";

const T = (1 + Math.sqrt(5)) / 2;

const ICOSAHEDRON_VERTICES = normalizeAll([
  [-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0],
  [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T],
  [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1],
]);

const ICOSAHEDRON_FACES: readonly (readonly [number, number, number])[] = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

export const TETRAHEDRON_SEED: PolyhedronSeed = Object.freeze({
  vertices: normalizeAll([[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]]),
  faces: Object.freeze([[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]]),
});

export const OCTAHEDRON_SEED: PolyhedronSeed = Object.freeze({
  vertices: normalizeAll([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]),
  faces: Object.freeze([[0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2], [1, 4, 2], [1, 3, 4], [1, 5, 3], [1, 2, 5]]),
});

export const ICOSAHEDRON_SEED: PolyhedronSeed = Object.freeze({
  vertices: ICOSAHEDRON_VERTICES,
  faces: ICOSAHEDRON_FACES,
});

export const DODECAHEDRON_SEED: PolyhedronSeed = dodecahedronFromIcosahedron();

function normalizeAll(source: readonly (readonly [number, number, number])[]): readonly (readonly [number, number, number])[] {
  return Object.freeze(source.map((p) => normalized(p[0], p[1], p[2])));
}

function dodecahedronFromIcosahedron(): PolyhedronSeed {
  const vertices = ICOSAHEDRON_FACES.map(([a, b, c]) => normalized(
    ICOSAHEDRON_VERTICES[a]![0] + ICOSAHEDRON_VERTICES[b]![0] + ICOSAHEDRON_VERTICES[c]![0],
    ICOSAHEDRON_VERTICES[a]![1] + ICOSAHEDRON_VERTICES[b]![1] + ICOSAHEDRON_VERTICES[c]![1],
    ICOSAHEDRON_VERTICES[a]![2] + ICOSAHEDRON_VERTICES[b]![2] + ICOSAHEDRON_VERTICES[c]![2],
  ));
  const faces = ICOSAHEDRON_VERTICES.map((axis, vertexIndex) => sortedAdjacentFaceIndices(vertices, axis, vertexIndex));
  return Object.freeze({ vertices: Object.freeze(vertices), faces: Object.freeze(faces) });
}

function sortedAdjacentFaceIndices(vertices: readonly (readonly [number, number, number])[], axis: readonly [number, number, number], vertexIndex: number): readonly number[] {
  const adjacent = ICOSAHEDRON_FACES.map((face, index) => face.includes(vertexIndex) ? index : -1).filter((index) => index >= 0);
  const first = vertices[adjacent[0]!]!;
  const u = normalized(first[0] - axis[0] * dot(first, axis), first[1] - axis[1] * dot(first, axis), first[2] - axis[2] * dot(first, axis));
  const v = cross(axis, u);
  return Object.freeze([...adjacent].sort((a, b) => angle(vertices[a]!, u, v) - angle(vertices[b]!, u, v)));
}

function angle(p: readonly [number, number, number], u: readonly [number, number, number], v: readonly [number, number, number]): number {
  return Math.atan2(dot(p, v), dot(p, u));
}

function cross(a: readonly [number, number, number], b: readonly [number, number, number]): readonly [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
