/**
 * The triangle, extruded.
 *
 * `types.ts` owns the cross-section and the tracer refracts through it in the
 * wall plane; this file lifts the same three vertices off that plane so the
 * camera has a solid to look at. Nothing here is authored — no mesh file, no
 * modelling tool — which is what guarantees the object and the caustic cannot
 * drift apart: change `PRISM_SIDE` or `PRISM_TILT_DEGREES` and the glass and the
 * rainbow move together.
 *
 * Eight triangles: two caps and one quad per side. Every face gets its own
 * vertices so the normals stay flat, because a prism whose normals are averaged
 * across an edge refracts as if it were rounded, and the whole point of the
 * shape is that its faces are planar.
 *
 * The same three edges also become the side planes `glass.wgsl` intersects to
 * find where a refracted ray leaves the solid; `planes()` builds them from the
 * same winding rule `optics.wgsl` uses for its outward normals.
 */

import type { Geometry, Gpu } from 'vgpu';
import { geometry } from 'vgpu';

import { PRISM_BACK_Z, PRISM_FRONT_Z, PRISM_TRIANGLE, type Triangle } from './types';

export interface PrismMeshData {
  /** Interleaved position (xyz) then normal (xyz), 6 floats per vertex. */
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint16Array<ArrayBuffer>;
}

/** Bytes between two vertices of `PrismMeshData.vertices`. */
export const PRISM_VERTEX_STRIDE = 24;

/**
 * Vertices and indices for the extruded triangle, wound counter-clockwise seen
 * from outside so `cull: 'back'` keeps the faces that face the camera.
 */
export function prismMeshData(
  triangle: Triangle = PRISM_TRIANGLE,
  backZ = PRISM_BACK_Z,
  frontZ = PRISM_FRONT_Z,
): PrismMeshData {
  const corners = [triangle.a, triangle.b, triangle.c];
  const vertices: number[] = [];
  const indices: number[] = [];
  const push = (
    point: readonly [number, number],
    z: number,
    normal: readonly [number, number, number],
  ): number => {
    const index = vertices.length / 6;
    vertices.push(point[0], point[1], z, normal[0], normal[1], normal[2]);
    return index;
  };

  for (let edge = 0; edge < 3; edge++) {
    const start = corners[edge]!;
    const end = corners[(edge + 1) % 3]!;
    const [nx, ny] = outwardNormal(start, end);
    const normal: readonly [number, number, number] = [nx, ny, 0];
    // Counter-clockwise from outside: along the edge at the back, up the far
    // side to the front, back along the edge, down again.
    const startBack = push(start, backZ, normal);
    const endBack = push(end, backZ, normal);
    const endFront = push(end, frontZ, normal);
    const startFront = push(start, frontZ, normal);
    indices.push(startBack, endBack, endFront, startBack, endFront, startFront);
  }

  const front = corners.map((corner) => push(corner, frontZ, [0, 0, 1]));
  indices.push(front[0]!, front[1]!, front[2]!);
  // The back cap faces away, so its winding is the cross-section's reversed.
  const back = corners.map((corner) => push(corner, backZ, [0, 0, -1]));
  indices.push(back[2]!, back[1]!, back[0]!);

  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

/**
 * The five outward planes whose intersection is the solid, as `(nx, ny, nz, d)`
 * with `dot(n, point) <= d` inside.
 *
 * `glass.wgsl` walks these to find how far a refracted ray travels before it
 * leaves the glass, which is both where it lands on the wall behind and how much
 * of it the glass absorbs on the way.
 */
export function prismPlanes(
  triangle: Triangle = PRISM_TRIANGLE,
  backZ = PRISM_BACK_Z,
  frontZ = PRISM_FRONT_Z,
): readonly (readonly [number, number, number, number])[] {
  const corners = [triangle.a, triangle.b, triangle.c];
  const sides = corners.map((start, edge) => {
    const [nx, ny] = outwardNormal(start, corners[(edge + 1) % 3]!);
    return [nx, ny, 0, nx * start[0] + ny * start[1]] as const;
  });
  return [...sides, [0, 0, 1, frontZ] as const, [0, 0, -1, -backZ] as const];
}

/** Uploads the mesh. The caller owns it and must `destroy()` it. */
export function prismGeometry(gpu: Gpu, label: string): Geometry {
  const { vertices, indices } = prismMeshData();
  return geometry(gpu, {
    label,
    buffers: [{
      data: vertices,
      stride: PRISM_VERTEX_STRIDE,
      attributes: { position: 'float32x3', normal: 'float32x3' },
    }],
    indices,
  });
}

/**
 * Outward normal of one edge of a counter-clockwise triangle.
 *
 * The same rotation `optics.wgsl` applies when it decides which side of an edge
 * a ray came from — the two have to agree, or the tracer would refract through a
 * face the mesh renders as its back.
 */
function outwardNormal(
  start: readonly [number, number],
  end: readonly [number, number],
): readonly [number, number] {
  const edge: readonly [number, number] = [end[0] - start[0], end[1] - start[1]];
  const length = Math.hypot(edge[0], edge[1]) || 1;
  return [edge[1] / length, -edge[0] / length];
}
