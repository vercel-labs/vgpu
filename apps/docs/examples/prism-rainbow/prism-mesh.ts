/**
 * Procedural, subtly filleted prism geometry.
 *
 * `types.ts` still owns the ideal triangular solid used by the CPU ray tracer
 * and by `glass.wgsl` when it measures the optical path. This file only rounds
 * the visible mesh inward, so the bevel can catch the environment without ever
 * moving the light-producing faces outside their analytically traced planes.
 *
 * The construction mirrors the validated text-to-cad model: an equilateral
 * triangle with a small fillet on all nine edges. The triangular cross-section
 * is replaced by tangent circular arcs, then quarter-round rings blend that
 * outline into inset front and back caps. Four segments resolve each rounded
 * direction, while the long straight runs are split independently so neither
 * the bevel strips nor the cap triangles span an entire side of the prism.
 */

import type { Geometry, Gpu } from "vgpu";
import { geometry } from "vgpu";

import {
  PRISM_BACK_Z,
  PRISM_FRONT_Z,
  PRISM_TRIANGLE,
  type Triangle,
} from "./types";

type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];

interface ContourPoint {
  readonly position: Vec2;
  readonly normal: Vec2;
}

export interface PrismMeshData {
  /** Interleaved position (xyz) then normal (xyz), 6 floats per vertex. */
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint16Array<ArrayBuffer>;
}

/** Bytes between two vertices of `PrismMeshData.vertices`. */
export const PRISM_VERTEX_STRIDE = 24;
/** 2.25 mm fillet on the 57 mm text-to-cad reference scale. */
export const PRISM_BEVEL_RADIUS = 0.0225;
/** Arc subdivisions around each triangular corner. */
export const PRISM_CORNER_SEGMENTS = 4;
/** Quarter-round subdivisions between each broad side and cap. */
export const PRISM_BEVEL_SEGMENTS = 4;
/** Longitudinal subdivisions along each straight run of the rounded contour. */
export const PRISM_EDGE_SEGMENTS = 16;

/**
 * Vertices and indices for the rounded prism, wound counter-clockwise from
 * outside so `cull: 'back'` keeps the faces that face the camera.
 */
export function prismMeshData(
  triangle: Triangle = PRISM_TRIANGLE,
  backZ = PRISM_BACK_Z,
  frontZ = PRISM_FRONT_Z
): PrismMeshData {
  const depth = Math.max(0, frontZ - backZ);
  const radius = Math.min(PRISM_BEVEL_RADIUS, depth * 0.45);
  const contour = roundedTriangleContour(triangle, radius);
  const vertices: number[] = [];
  const indices: number[] = [];
  const rings: number[][] = [];

  const push = (position: Vec3, normal: Vec3): number => {
    const index = vertices.length / 6;
    vertices.push(...position, ...normal);
    return index;
  };
  const addRing = (theta: number, z: number, zNormal: number): number[] => {
    const inset = radius * (1 - Math.cos(theta));
    const xyWeight = Math.cos(theta);
    const ring = contour.map(({ position, normal }) =>
      push(
        [position[0] - normal[0] * inset, position[1] - normal[1] * inset, z],
        [normal[0] * xyWeight, normal[1] * xyWeight, zNormal]
      )
    );
    rings.push(ring);
    return ring;
  };

  // Stop a fraction short of pi/2 so the tiny cap corner arcs retain positive
  // area instead of collapsing every sample at a corner onto the same point.
  const maxTheta = Math.PI / 2 - 0.06;
  const maxSine = Math.sin(maxTheta);
  for (let step = PRISM_BEVEL_SEGMENTS; step >= 0; step--) {
    const theta = (maxTheta * step) / PRISM_BEVEL_SEGMENTS;
    addRing(
      theta,
      backZ + radius - (radius * Math.sin(theta)) / maxSine,
      -Math.sin(theta)
    );
  }
  for (let step = 0; step <= PRISM_BEVEL_SEGMENTS; step++) {
    const theta = (maxTheta * step) / PRISM_BEVEL_SEGMENTS;
    addRing(
      theta,
      frontZ - radius + (radius * Math.sin(theta)) / maxSine,
      Math.sin(theta)
    );
  }

  for (let band = 0; band < rings.length - 1; band++) {
    const current = rings[band]!;
    const next = rings[band + 1]!;
    for (let point = 0; point < contour.length; point++) {
      const following = (point + 1) % contour.length;
      indices.push(
        current[point]!,
        current[following]!,
        next[following]!,
        current[point]!,
        next[following]!,
        next[point]!
      );
    }
  }

  addCap(rings[0]!, [0, 0, -1], true);
  addCap(rings[rings.length - 1]!, [0, 0, 1], false);

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint16Array(indices),
  };

  function addCap(
    sourceRing: readonly number[],
    normal: Vec3,
    reverse: boolean
  ): void {
    const cap = sourceRing.map((source) => {
      const base = source * 6;
      return push(
        [vertices[base]!, vertices[base + 1]!, vertices[base + 2]!],
        normal
      );
    });
    const center: Vec3 = [
      cap.reduce((sum, index) => sum + vertices[index * 6]!, 0) / cap.length,
      cap.reduce((sum, index) => sum + vertices[index * 6 + 1]!, 0) /
        cap.length,
      cap.reduce((sum, index) => sum + vertices[index * 6 + 2]!, 0) /
        cap.length,
    ];
    const centerIndex = push(center, normal);
    for (let point = 0; point < cap.length; point++) {
      const following = (point + 1) % cap.length;
      if (reverse) indices.push(centerIndex, cap[following]!, cap[point]!);
      else indices.push(centerIndex, cap[point]!, cap[following]!);
    }
  }
}

/** Unique line-list edges for visualising the generated topology. */
export function prismWireframeIndices(
  triangleIndices: Uint16Array<ArrayBuffer>
): Uint16Array<ArrayBuffer> {
  const seen = new Set<number>();
  const edges: number[] = [];
  for (let triangle = 0; triangle < triangleIndices.length; triangle += 3) {
    append(triangleIndices[triangle]!, triangleIndices[triangle + 1]!);
    append(triangleIndices[triangle + 1]!, triangleIndices[triangle + 2]!);
    append(triangleIndices[triangle + 2]!, triangleIndices[triangle]!);
  }
  return new Uint16Array(edges);

  function append(a: number, b: number): void {
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    const key = start * 65_536 + end;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(start, end);
  }
}

/**
 * The five ideal outward planes whose intersection is the optical solid, as
 * `(nx, ny, nz, d)` with `dot(n, point) <= d` inside.
 */
export function prismPlanes(
  triangle: Triangle = PRISM_TRIANGLE,
  backZ = PRISM_BACK_Z,
  frontZ = PRISM_FRONT_Z
): readonly (readonly [number, number, number, number])[] {
  const corners = [triangle.a, triangle.b, triangle.c];
  const sides = corners.map((start, edge) => {
    const [nx, ny] = outwardNormal(start, corners[(edge + 1) % 3]!);
    return [nx, ny, 0, nx * start[0] + ny * start[1]] as const;
  });
  return [...sides, [0, 0, 1, frontZ] as const, [0, 0, -1, -backZ] as const];
}

/** Uploads the solid triangle mesh. The caller owns it and must `destroy()` it. */
export function prismGeometry(gpu: Gpu, label: string): Geometry {
  const { vertices, indices } = prismMeshData();
  return upload(gpu, label, vertices, indices);
}

/** Uploads the same mesh as unique triangle edges for a line-list overlay. */
export function prismWireframeGeometry(gpu: Gpu, label: string): Geometry {
  const { vertices, indices } = prismMeshData();
  return upload(gpu, label, vertices, prismWireframeIndices(indices), true);
}

function upload(
  gpu: Gpu,
  label: string,
  vertices: Float32Array<ArrayBuffer>,
  indices: Uint16Array<ArrayBuffer>,
  wireframe = false
): Geometry {
  return geometry(gpu, {
    label,
    ...(wireframe ? { topology: "line-list" as const } : {}),
    buffers: [
      {
        data: vertices,
        stride: PRISM_VERTEX_STRIDE,
        attributes: { position: "float32x3", normal: "float32x3" },
      },
    ],
    indices,
  });
}

function roundedTriangleContour(
  triangle: Triangle,
  radius: number
): ContourPoint[] {
  const corners = [triangle.a, triangle.b, triangle.c];
  const arcs = corners.map((corner, index) => {
    const previous = corners[(index + corners.length - 1) % corners.length]!;
    const next = corners[(index + 1) % corners.length]!;
    const towardPrevious = normalize2([
      previous[0] - corner[0],
      previous[1] - corner[1],
    ]);
    const towardNext = normalize2([next[0] - corner[0], next[1] - corner[1]]);
    const halfAngle =
      Math.acos(clamp(dot2(towardPrevious, towardNext), -1, 1)) / 2;
    const tangentDistance = radius / Math.max(Math.tan(halfAngle), 1e-6);
    const centerDistance = radius / Math.max(Math.sin(halfAngle), 1e-6);
    const bisector = normalize2([
      towardPrevious[0] + towardNext[0],
      towardPrevious[1] + towardNext[1],
    ]);
    const center: Vec2 = [
      corner[0] + bisector[0] * centerDistance,
      corner[1] + bisector[1] * centerDistance,
    ];
    const start: Vec2 = [
      corner[0] + towardPrevious[0] * tangentDistance,
      corner[1] + towardPrevious[1] * tangentDistance,
    ];
    const end: Vec2 = [
      corner[0] + towardNext[0] * tangentDistance,
      corner[1] + towardNext[1] * tangentDistance,
    ];
    const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
    let endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
    while (endAngle <= startAngle) endAngle += Math.PI * 2;
    return Array.from(
      { length: PRISM_CORNER_SEGMENTS + 1 },
      (_, step): ContourPoint => {
        const angle =
          startAngle + ((endAngle - startAngle) * step) / PRISM_CORNER_SEGMENTS;
        const normal: Vec2 = [Math.cos(angle), Math.sin(angle)];
        return {
          position: [
            center[0] + normal[0] * radius,
            center[1] + normal[1] * radius,
          ],
          normal,
        };
      }
    );
  });

  return arcs.flatMap((arc, index) => {
    const end = arc[arc.length - 1]!;
    const nextArc = arcs[(index + 1) % arcs.length]!;
    const nextStart = nextArc[0]!;
    const edgeNormal = outwardNormal(
      corners[index]!,
      corners[(index + 1) % corners.length]!
    );
    const straight = Array.from(
      { length: PRISM_EDGE_SEGMENTS - 1 },
      (_, step): ContourPoint => {
        const amount = (step + 1) / PRISM_EDGE_SEGMENTS;
        return {
          position: [
            end.position[0] +
              (nextStart.position[0] - end.position[0]) * amount,
            end.position[1] +
              (nextStart.position[1] - end.position[1]) * amount,
          ],
          normal: edgeNormal,
        };
      }
    );
    return [...arc, ...straight];
  });
}

function normalize2(value: Vec2): Vec2 {
  const length = Math.hypot(...value) || 1;
  return [value[0] / length, value[1] / length];
}

function dot2(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Outward normal of one edge of a counter-clockwise triangle. */
function outwardNormal(start: Vec2, end: Vec2): Vec2 {
  const edge: Vec2 = [end[0] - start[0], end[1] - start[1]];
  const length = Math.hypot(...edge) || 1;
  return [edge[1] / length, -edge[0] / length];
}
