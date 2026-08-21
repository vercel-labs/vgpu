/**
 * The geometry of the room: the solid, the planes the glass shader intersects,
 * and the framing the camera has to hold. No GPU, no images — every claim here is
 * a number the picture depends on.
 *
 * Three things are worth asserting and were all wrong at some point while this
 * was being written:
 *
 *  - The mesh really is the traced triangle extruded. If it drifted, the object
 *    the camera shows and the shadow the tracer paints would be different shapes.
 *  - Its five planes really bound it, and every face is wound so `cull: 'back'`
 *    keeps the ones pointing at the viewer. A flipped winding is invisible in a
 *    still frame of a dark solid and obvious the moment the camera moves.
 *  - The wall covers the frame. It is sized from the camera rather than chosen, so
 *    this is the test that stands in for the size being right.
 */

import { describe, expect, test } from "vitest";

import { cameraView, wallCoverage, wallHalfHeight } from "./camera";
import {
  PRISM_BEVEL_RADIUS,
  PRISM_BEVEL_SEGMENTS,
  PRISM_CORNER_SEGMENTS,
  PRISM_EDGE_SEGMENTS,
  PRISM_VERTEX_STRIDE,
  prismMeshData,
  prismPlanes,
  prismWireframeIndices,
} from "./prism-mesh";
import { lampAt } from "./scene";
import { prismSilhouette } from "./validation";
import {
  PRISM_BACK_Z,
  PRISM_DEFAULT_ARC,
  PRISM_FRONT_Z,
  PRISM_LIGHT_PLANE_Z,
  PRISM_SIDE,
  PRISM_TRIANGLE,
} from "./types";

type Vec3 = readonly [number, number, number];

const { vertices, indices } = prismMeshData();
const planes = prismPlanes();

function vertexAt(index: number): {
  readonly position: Vec3;
  readonly normal: Vec3;
} {
  const base = index * 6;
  return {
    position: [vertices[base]!, vertices[base + 1]!, vertices[base + 2]!],
    normal: [vertices[base + 3]!, vertices[base + 4]!, vertices[base + 5]!],
  };
}

const vertexCount = vertices.length / 6;
const centroid: Vec3 = [
  (PRISM_TRIANGLE.a[0] + PRISM_TRIANGLE.b[0] + PRISM_TRIANGLE.c[0]) / 3,
  (PRISM_TRIANGLE.a[1] + PRISM_TRIANGLE.b[1] + PRISM_TRIANGLE.c[1]) / 3,
  (PRISM_BACK_Z + PRISM_FRONT_Z) / 2,
];

/** Equal to the precision the vertex buffer keeps, which is f32. */
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

const subtract = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

describe("the extruded prism", () => {
  test("presents an upright triangular face to the resting camera", () => {
    expect(PRISM_TRIANGLE.a[0]).toBeCloseTo(0, 12);
    expect(PRISM_TRIANGLE.b[1]).toBeCloseTo(PRISM_TRIANGLE.c[1], 12);
    expect(PRISM_TRIANGLE.b[0]).toBeLessThan(0);
    expect(PRISM_TRIANGLE.c[0]).toBeGreaterThan(0);
  });

  test("rounds the visible solid inward without changing its optical envelope", () => {
    const contourPoints = 3 * (PRISM_CORNER_SEGMENTS + PRISM_EDGE_SEGMENTS);
    const ringCount = 2 * (PRISM_BEVEL_SEGMENTS + 1);
    // Every bevel ring shares one fixed contour; each cap duplicates that ring
    // for a flat normal and adds a centre vertex for its triangle fan.
    expect(vertexCount).toBe(
      ringCount * contourPoints + 2 * (contourPoints + 1)
    );
    expect(indices).toHaveLength(
      ((ringCount - 1) * contourPoints * 2 + contourPoints * 2) * 3
    );
    expect(PRISM_VERTEX_STRIDE).toBe(24);

    const corners = [PRISM_TRIANGLE.a, PRISM_TRIANGLE.b, PRISM_TRIANGLE.c];
    let intermediateDepths = 0;
    let blendedNormals = 0;
    for (let index = 0; index < vertexCount; index++) {
      const { position, normal } = vertexAt(index);
      expect(position[2]).toBeGreaterThanOrEqual(PRISM_BACK_Z - 1e-6);
      expect(position[2]).toBeLessThanOrEqual(PRISM_FRONT_Z + 1e-6);
      if (
        !near(position[2], PRISM_BACK_Z) &&
        !near(position[2], PRISM_FRONT_Z)
      ) {
        intermediateDepths++;
      }
      if (Math.abs(normal[2]) > 0.05 && Math.abs(normal[2]) < 0.95)
        blendedNormals++;

      // Rounding cuts material away: it never adds a point beyond one of the
      // ideal planes through which the analytic tracer refracts.
      for (const [nx, ny, nz, offset] of planes) {
        expect(dot([nx, ny, nz], position) - offset).toBeLessThan(1e-6);
      }
    }
    expect(intermediateDepths).toBeGreaterThan(contourPoints * 2);
    expect(blendedNormals).toBeGreaterThan(contourPoints * 2);
    // The sharp mathematical corners are gone from the visual mesh.
    expect(
      corners.every(([x, y]) =>
        Array.from(
          { length: vertexCount },
          (_, index) => vertexAt(index).position
        ).every((position) => !near(x, position[0]) || !near(y, position[1]))
      )
    ).toBe(true);
    expect(PRISM_BEVEL_RADIUS).toBeLessThan(0.03);
    // The back face is against the wall and the front face is towards the camera.
    expect(PRISM_BACK_Z).toBeGreaterThan(0);
    expect(PRISM_FRONT_Z).toBeGreaterThan(PRISM_BACK_Z);
    expect(PRISM_LIGHT_PLANE_Z).toBeCloseTo(
      (PRISM_BACK_Z + PRISM_FRONT_Z) * 0.5
    );
    expect(PRISM_LIGHT_PLANE_Z).toBeGreaterThan(PRISM_BACK_Z);
    expect(PRISM_LIGHT_PLANE_Z).toBeLessThan(PRISM_FRONT_Z);
  });

  test("subdivides every long bevel run and connects the cap boundary to it", () => {
    const contourPoints = 3 * (PRISM_CORNER_SEGMENTS + PRISM_EDGE_SEGMENTS);
    const firstRing = Array.from(
      { length: contourPoints },
      (_, index) => vertexAt(index).position
    );
    const boundaryLengths = firstRing.map((position, index) => {
      const next = firstRing[(index + 1) % firstRing.length]!;
      return Math.hypot(
        next[0] - position[0],
        next[1] - position[1],
        next[2] - position[2]
      );
    });
    expect(Math.max(...boundaryLengths)).toBeLessThan(
      (PRISM_SIDE / PRISM_EDGE_SEGMENTS) * 1.01
    );

    const ringCount = 2 * (PRISM_BEVEL_SEGMENTS + 1);
    const firstCapVertex = ringCount * contourPoints;
    const capBoundary = new Set(
      Array.from(
        { length: contourPoints },
        (_, index) => firstCapVertex + index
      )
    );
    const capIndices = Array.from(indices).slice(-contourPoints * 2 * 3);
    expect([...capBoundary].every((index) => capIndices.includes(index))).toBe(
      true
    );
  });

  test("has smooth unit normals and faces wound counter-clockwise from outside", () => {
    for (let index = 0; index < vertexCount; index++) {
      const { position, normal } = vertexAt(index);
      expect(Math.hypot(...normal)).toBeCloseTo(1, 6);
      expect(dot(normal, subtract(position, centroid))).toBeGreaterThan(0);
    }
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const [a, b, c] = [0, 1, 2].map((offset) =>
        vertexAt(indices[triangle + offset]!)
      );
      const geometric = cross(
        subtract(b!.position, a!.position),
        subtract(c!.position, a!.position)
      );
      const area = Math.hypot(...geometric);
      // The smallest bevel facets scale with radius squared; this rejects truly
      // collapsed triangles without baking the previous bevel size into the test.
      expect(area).toBeGreaterThan(PRISM_BEVEL_RADIUS ** 2 * 0.001);
      const geometricNormal: Vec3 = [
        geometric[0] / area,
        geometric[1] / area,
        geometric[2] / area,
      ];
      // A faceted triangle approximates a curved fillet, so its plane need not
      // equal any one vertex normal. It must agree with every interpolated
      // endpoint and point away from the solid.
      expect(dot(geometricNormal, a!.normal)).toBeGreaterThan(0.9);
      expect(dot(geometricNormal, b!.normal)).toBeGreaterThan(0.9);
      expect(dot(geometricNormal, c!.normal)).toBeGreaterThan(0.9);
      const triangleCenter: Vec3 = [
        (a!.position[0] + b!.position[0] + c!.position[0]) / 3,
        (a!.position[1] + b!.position[1] + c!.position[1]) / 3,
        (a!.position[2] + b!.position[2] + c!.position[2]) / 3,
      ];
      expect(
        dot(geometricNormal, subtract(triangleCenter, centroid))
      ).toBeGreaterThan(0);
    }
  });

  test("turns every triangle edge into one unique line-list edge", () => {
    const wireframe = prismWireframeIndices(indices);
    expect(wireframe.length % 2).toBe(0);
    const edges = new Set<string>();
    for (let index = 0; index < wireframe.length; index += 2) {
      const start = wireframe[index]!;
      const end = wireframe[index + 1]!;
      expect(start).toBeLessThan(vertexCount);
      expect(end).toBeLessThan(vertexCount);
      expect(start).toBeLessThan(end);
      edges.add(`${start}:${end}`);
    }
    expect(edges.size * 2).toBe(wireframe.length);
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const corners = [
        indices[triangle]!,
        indices[triangle + 1]!,
        indices[triangle + 2]!,
      ];
      for (let edge = 0; edge < 3; edge++) {
        const a = corners[edge]!;
        const b = corners[(edge + 1) % 3]!;
        expect(edges.has(`${Math.min(a, b)}:${Math.max(a, b)}`)).toBe(true);
      }
    }
  });

  test("is the intersection of its five planes, and each one touches it", () => {
    expect(planes).toHaveLength(5);
    for (const [nx, ny, nz, offset] of planes) {
      const normal: Vec3 = [nx, ny, nz];
      expect(Math.hypot(...normal)).toBeCloseTo(1, 12);
      let onPlane = 0;
      for (let index = 0; index < vertexCount; index++) {
        const distance = dot(normal, vertexAt(index).position) - offset;
        // Convexity: no vertex is outside any plane.
        expect(distance).toBeLessThan(1e-6);
        if (near(distance, 0)) onPlane++;
      }
      // A plane that no face lies on would be a half-space that does not bound the
      // solid, and the exit distance through it would be a lie.
      expect(onPlane).toBeGreaterThanOrEqual(3);
    }
  });

  test("a ray from inside leaves through the nearest of those planes", () => {
    const exit = (origin: Vec3, direction: Vec3): number =>
      Math.min(
        ...planes
          .map(([nx, ny, nz, offset]) => {
            const denominator = dot([nx, ny, nz], direction);
            return denominator <= 1e-5
              ? Infinity
              : (offset - dot([nx, ny, nz], origin)) / denominator;
          })
          .filter((distance) => distance > 1e-6)
      );

    const directions: readonly Vec3[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
      [0.6, -0.5, 0.62],
      [-0.4, 0.8, -0.45],
    ];
    for (const raw of directions) {
      const length = Math.hypot(...raw);
      const direction: Vec3 = [
        raw[0] / length,
        raw[1] / length,
        raw[2] / length,
      ];
      const distance = exit(centroid, direction);
      expect(distance).toBeGreaterThan(0);
      expect(Number.isFinite(distance)).toBe(true);
      const landing: Vec3 = [
        centroid[0] + direction[0] * distance,
        centroid[1] + direction[1] * distance,
        centroid[2] + direction[2] * distance,
      ];
      // The exit point is on the boundary...
      const outermost = Math.max(
        ...planes.map(
          ([nx, ny, nz, offset]) => dot([nx, ny, nz], landing) - offset
        )
      );
      expect(Math.abs(outermost)).toBeLessThan(1e-9);
      // ...and everything before it is strictly inside, so the distance is the
      // thickness of the glass along that ray and not the far side of it.
      const before: Vec3 = [
        centroid[0] + direction[0] * distance * 0.99,
        centroid[1] + direction[1] * distance * 0.99,
        centroid[2] + direction[2] * distance * 0.99,
      ];
      expect(
        Math.max(
          ...planes.map(
            ([nx, ny, nz, offset]) => dot([nx, ny, nz], before) - offset
          )
        )
      ).toBeLessThan(-1e-6);
    }
  });
});

describe("the camera", () => {
  /** Canvas shapes from a phone in portrait to a very wide desktop hero. */
  const ASPECTS = [0.4, 0.56, 0.75, 1, 1.33, 16 / 9, 2.4, 4];

  test("never sees past the wall, at any canvas shape or pointer position", () => {
    for (const aspect of ASPECTS) {
      const halfHeight = wallHalfHeight(aspect);
      for (let orbitX = -1; orbitX <= 1; orbitX += 0.25) {
        for (let orbitY = -1; orbitY <= 1; orbitY += 0.25) {
          // Below 1 the traced rectangle covers the frame. At 1 a corner of the
          // frame sits on its edge and the picture ends in a hard line.
          expect(
            wallCoverage(aspect, orbitX, orbitY) / halfHeight,
            `aspect ${aspect} orbit ${orbitX},${orbitY}`
          ).toBeLessThan(1);
        }
      }
    }
  });

  test("sizes the wall to the frame, and never large enough to reach the lamp", () => {
    // A wider canvas sees more wall, so more of it has to be traced.
    const heights = ASPECTS.map((aspect) => wallHalfHeight(aspect));
    expect(heights[heights.length - 1]!).toBeGreaterThan(heights[3]!);
    for (const [index, aspect] of ASPECTS.entries()) {
      const [halfWidth, halfHeight] = [
        heights[index]! * aspect,
        heights[index]!,
      ];
      expect(halfHeight).toBeGreaterThan(0.5);
      // The lamp is an emitter, not an object: the wall's direct term divides by
      // the distance to it, so a traced rectangle that reached the lamp would
      // paint a singularity on the wall. It has to stay outside, at both ends of
      // the arc the pointer can swing it along.
      for (const arc of [0, PRISM_DEFAULT_ARC, 1]) {
        const [x, y] = lampAt(arc).center;
        expect(
          Math.abs(x) > halfWidth || Math.abs(y) > halfHeight,
          `aspect ${aspect} arc ${arc} lamp at ${x.toFixed(2)},${y.toFixed(
            2
          )} inside ${halfWidth.toFixed(2)}x${halfHeight.toFixed(2)}`
        ).toBe(true);
      }
    }
  });

  test("keeps the composed shot framed and remains visible on narrow screens", () => {
    for (const aspect of [0.56, 1, 16 / 9, 2.4]) {
      for (const orbit of [
        [0, 0],
        [-1, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
      ] as const) {
        const box = prismSilhouette(aspect, orbit);
        if (aspect >= 1) {
          expect(box.x0, `aspect ${aspect}`).toBeGreaterThan(0);
          expect(box.x1, `aspect ${aspect}`).toBeLessThan(1);
        } else {
          // The intentionally close new default crops a sliver of the prism on
          // portrait phones, but must never move the subject out of the frame.
          expect(box.x0, `aspect ${aspect}`).toBeLessThan(1);
          expect(box.x1, `aspect ${aspect}`).toBeGreaterThan(0);
        }
        expect(box.y0, `aspect ${aspect}`).toBeGreaterThan(0);
        expect(box.y1, `aspect ${aspect}`).toBeLessThan(1);
      }
    }
    // The origin is the middle of the frame: the camera orbits around the prism.
    for (const orbit of [
      [0, 0],
      [1, -1],
      [-1, 1],
    ] as const) {
      const matrix = cameraView(16 / 9, orbit[0], orbit[1]).camera
        .viewProjection;
      expect(matrix[12]! / matrix[15]!).toBeCloseTo(0, 6);
      expect(matrix[13]! / matrix[15]!).toBeCloseTo(0, 6);
    }
    const rest = cameraView(16 / 9);
    expect(rest.position[0]).toBeCloseTo(0, 8);
    expect(rest.position[1]).toBeCloseTo(0, 8);
    expect(rest.forward[0]).toBeCloseTo(0, 8);
    expect(rest.forward[1]).toBeCloseTo(0, 8);
  });

  test("derives the camera and wall from runtime distance and FOV", () => {
    const distance = 3.2;
    const fov = 56;
    const view = cameraView(16 / 9, 0, 0, distance, fov);
    expect(Math.hypot(...view.position)).toBeCloseTo(distance, 8);

    const defaultWall = wallHalfHeight(16 / 9);
    const configuredWall = wallHalfHeight(16 / 9, distance, fov);
    expect(configuredWall).toBeGreaterThan(defaultWall);
    for (const orbitX of [-1, 0, 1]) {
      for (const orbitY of [-1, 0, 1]) {
        expect(
          wallCoverage(16 / 9, orbitX, orbitY, distance, fov) / configuredWall
        ).toBeLessThan(1);
      }
    }
  });

  test("shows the glass standing off the wall, not painted on it", () => {
    // The whole point of the restructure: the caustic is on a plane at z = 0 and
    // the solid is in front of it, so a camera move slides one against the other.
    // If the prism were composited onto the wall this separation would be fixed.
    const project = (
      point: Vec3,
      orbit: readonly [number, number]
    ): readonly [number, number] => {
      const matrix = cameraView(16 / 9, orbit[0], orbit[1]).camera
        .viewProjection;
      const clip = [0, 1, 3].map(
        (row) =>
          matrix[row]! * point[0] +
          matrix[4 + row]! * point[1] +
          matrix[8 + row]! * point[2] +
          matrix[12 + row]!
      );
      return [clip[0]! / clip[2]!, clip[1]! / clip[2]!];
    };
    const onWall: Vec3 = [PRISM_TRIANGLE.c[0], PRISM_TRIANGLE.c[1], 0];
    const onGlass: Vec3 = [
      PRISM_TRIANGLE.c[0],
      PRISM_TRIANGLE.c[1],
      PRISM_FRONT_Z,
    ];
    const separation = (orbit: readonly [number, number]): number => {
      const [wallX, wallY] = project(onWall, orbit);
      const [glassX, glassY] = project(onGlass, orbit);
      return Math.hypot(glassX - wallX, glassY - wallY);
    };
    const rest = separation([0, 0]);
    // The composed shot is square to the wall. Perspective still makes the
    // nearer front face slightly larger than its wall projection, while a
    // pointer orbit changes that separation and reveals the side faces.
    expect(rest).toBeGreaterThan(0.01);
    expect(Math.abs(separation([1, 1]) - rest)).toBeGreaterThan(0.002);
    expect(Math.abs(separation([-1, -1]) - rest)).toBeGreaterThan(0.002);
  });
});
