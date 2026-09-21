import type { Geometry, Gpu } from "vgpu";
import { geometry } from "vgpu";

import type { Triangle, Vec2 } from "../../../../types";

export interface ShadowMeshOptions {
  readonly projection: Vec2;
  readonly nearPenumbra: number;
  readonly farPenumbra: number;
  readonly midRing: number;
  readonly midCoverage: number;
}

export interface ShadowMeshData {
  /** Interleaved position.xy, coverage, projection travel. */
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly hull: readonly Vec2[];
  readonly hullTravel: readonly number[];
}

interface CastPoint {
  readonly position: Vec2;
  readonly travel: number;
}

/**
 * Sweeps the prism silhouette along one wall-space light direction. The core is
 * a non-overlapping convex fan; two expanded rings carry the soft boundary in
 * vertex coverage, so the production pass needs neither a blur nor a target.
 */
export function buildShadowMesh(
  triangle: Triangle,
  options: ShadowMeshOptions
): ShadowMeshData {
  const source = [triangle.a, triangle.b, triangle.c];
  const points: CastPoint[] = source.flatMap((position) => [
    { position, travel: 0 },
    {
      position: [
        position[0] + options.projection[0],
        position[1] + options.projection[1],
      ],
      travel: 1,
    },
  ]);
  const hull = convexHull(points);
  if (hull.length < 3)
    throw new Error("A cast-shadow hull needs three points.");

  const positions = hull.map(({ position }) => position);
  const travel = hull.map(({ travel }) => travel);
  const widths = travel.map((value) =>
    mix(options.nearPenumbra, options.farPenumbra, value)
  );
  const middle = offsetConvexPolygon(
    positions,
    widths.map((width) => width * options.midRing)
  );
  const outer = offsetConvexPolygon(positions, widths);
  const center = polygonCentroid(positions);
  const centerTravel =
    travel.reduce((sum, value) => sum + value, 0) / travel.length;
  const vertices: number[] = [center[0], center[1], 1, centerTravel];

  appendRing(vertices, positions, 1, travel);
  appendRing(vertices, middle, options.midCoverage, travel);
  appendRing(vertices, outer, 0, travel);

  const count = positions.length;
  const coreStart = 1;
  const middleStart = coreStart + count;
  const outerStart = middleStart + count;
  const indices: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    indices.push(0, coreStart + index, coreStart + next);
    appendQuad(
      indices,
      coreStart + index,
      coreStart + next,
      middleStart + index,
      middleStart + next
    );
    appendQuad(
      indices,
      middleStart + index,
      middleStart + next,
      outerStart + index,
      outerStart + next
    );
  }
  return {
    vertices: new Float32Array(vertices),
    // u32 keeps every valid polygon size aligned for queue.writeBuffer; a
    // five-vertex hull produces 75 indices, whose u16 byte length is not / 4.
    indices: new Uint32Array(indices),
    hull: positions,
    hullTravel: travel,
  };
}

export function createShadowGeometry(
  gpu: Gpu,
  label: string,
  triangle: Triangle,
  options: ShadowMeshOptions
): Geometry {
  const mesh = buildShadowMesh(triangle, options);
  return geometry(gpu, {
    label,
    buffers: [
      {
        data: mesh.vertices,
        stride: 16,
        attributes: {
          position: "float32x2",
          coverage: "float32",
          travel: "float32",
        },
      },
    ],
    indices: mesh.indices,
  });
}

function appendRing(
  target: number[],
  positions: readonly Vec2[],
  coverage: number,
  travel: readonly number[]
): void {
  positions.forEach((position, index) => {
    target.push(position[0], position[1], coverage, travel[index]!);
  });
}

function appendQuad(
  target: number[],
  inner: number,
  innerNext: number,
  outer: number,
  outerNext: number
): void {
  target.push(inner, outer, outerNext, inner, outerNext, innerNext);
}

function convexHull(points: readonly CastPoint[]): CastPoint[] {
  const sorted = [...points].sort(
    (left, right) =>
      left.position[0] - right.position[0] ||
      left.position[1] - right.position[1]
  );
  const half = (entries: readonly CastPoint[]): CastPoint[] => {
    const result: CastPoint[] = [];
    for (const point of entries) {
      while (
        result.length >= 2 &&
        cross(
          result.at(-2)!.position,
          result.at(-1)!.position,
          point.position
        ) <= 1e-9
      ) {
        result.pop();
      }
      result.push(point);
    }
    return result;
  };
  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function offsetConvexPolygon(
  polygon: readonly Vec2[],
  widths: readonly number[]
): Vec2[] {
  return polygon.map((point, index) => {
    const previous = polygon[(index + polygon.length - 1) % polygon.length]!;
    const next = polygon[(index + 1) % polygon.length]!;
    const incoming = normalize([
      point[0] - previous[0],
      point[1] - previous[1],
    ]);
    const outgoing = normalize([next[0] - point[0], next[1] - point[1]]);
    const previousNormal: Vec2 = [incoming[1], -incoming[0]];
    const nextNormal: Vec2 = [outgoing[1], -outgoing[0]];
    const miter = normalize([
      previousNormal[0] + nextNormal[0],
      previousNormal[1] + nextNormal[1],
    ]);
    const scale = widths[index]! / Math.max(dot(miter, nextNormal), 0.25);
    return [point[0] + miter[0] * scale, point[1] + miter[1] * scale];
  });
}

function polygonCentroid(polygon: readonly Vec2[]): Vec2 {
  let weightedX = 0;
  let weightedY = 0;
  let signedArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const point = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    const area = point[0] * next[1] - next[0] * point[1];
    weightedX += (point[0] + next[0]) * area;
    weightedY += (point[1] + next[1]) * area;
    signedArea += area;
  }
  const divisor = 3 * signedArea;
  return [weightedX / divisor, weightedY / divisor];
}

function normalize(value: Vec2): Vec2 {
  const length = Math.hypot(value[0], value[1]);
  return length > 1e-9 ? [value[0] / length, value[1] / length] : [0, 0];
}

function dot(left: Vec2, right: Vec2): number {
  return left[0] * right[0] + left[1] * right[1];
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}
