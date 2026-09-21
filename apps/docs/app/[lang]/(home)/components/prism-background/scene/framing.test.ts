import { describe, expect, test } from "vitest";

import { cameraView } from "./camera";
import {
  alignProjection,
  applyProjectionFraming,
  fitProjectionDistance,
  framingCoverage,
  projectedBounds,
  viewportWithinCanvas,
} from "./framing";
import { prismMeshData } from "./prism-mesh";
import { lightWallExtent, wallExtent } from "../runtime/state";
import { PRISM_FRONT_Z } from "../types";

const PRISM_FRAME_POINTS = (() => {
  const vertices = prismMeshData().vertices;
  const points: [number, number, number][] = [];
  for (let index = 0; index < vertices.length; index += 6) {
    points.push([vertices[index]!, vertices[index + 1]!, vertices[index + 2]!]);
  }
  return points;
})();

describe("responsive prism framing", () => {
  test("overscans light travel only for portrait canvases", () => {
    const portraitWall = wallExtent(0.5);
    const portraitLight = lightWallExtent(0.5);
    expect(portraitLight[0]).toBeCloseTo(portraitWall[0] * 2);
    expect(portraitLight[1]).toBeCloseTo(portraitWall[1] * 2);
    expect(lightWallExtent(2)).toEqual(wallExtent(2));
  });

  test("measures the target relative to its canvas instead of the window", () => {
    expect(
      viewportWithinCanvas(
        { left: 200, top: 80, width: 1000, height: 500 },
        { left: 700, top: 130, width: 450, height: 400 }
      )
    ).toEqual({ left: 0.5, top: 0.1, right: 0.95, bottom: 0.9 });
  });

  test("clips a target to the canvas and rejects an empty intersection", () => {
    expect(
      viewportWithinCanvas(
        { left: 100, top: 50, width: 400, height: 200 },
        { left: 0, top: 0, width: 300, height: 400 }
      )
    ).toEqual({ left: 0, top: 0, right: 0.5, bottom: 1 });
    expect(
      viewportWithinCanvas(
        { left: 100, top: 50, width: 400, height: 200 },
        { left: 600, top: 50, width: 100, height: 100 }
      )
    ).toBeUndefined();
  });

  test("applies scale and principal-point offset without changing depth", () => {
    const matrix = new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    const framed = applyProjectionFraming(matrix, {
      scale: 0.5,
      offset: [0.25, -0.2],
    });
    expect(framed[0]).toBeCloseTo(0.5);
    expect(framed[5]).toBeCloseTo(0.5);
    expect(framed[12]).toBeCloseTo(0.25);
    expect(framed[13]).toBeCloseTo(-0.2);
    expect(framed[10]).toBe(1);
    expect(framed[15]).toBe(1);
  });

  test("aligns the actual silhouette centre without changing its scale", () => {
    const framing = alignProjection(
      { x0: -0.6, y0: -0.2, x1: 0.4, y1: 0.8 },
      { left: 0.5, top: 0.1, right: 0.95, bottom: 0.9 }
    );
    expect(framing.scale).toBe(1);
    expect(framing.offset[0]).toBeCloseTo(0.55);
    expect(framing.offset[1]).toBeCloseTo(-0.3);
  });

  test("backs the camera away to the first contained distance", () => {
    const viewport = { left: 0.5, top: 0, right: 1, bottom: 1 };
    const fit = fitProjectionDistance(
      viewport,
      (distance) => ({
        x0: -1 / distance,
        y0: -0.5 / distance,
        x1: 1 / distance,
        y1: 0.5 / distance,
      }),
      0.5,
      10
    );
    expect(fit.distance).toBeCloseTo(2, 8);
    expect(fit.framing.scale).toBe(1);
    expect(fit.framing.offset).toEqual([0.5, 0]);
  });

  test.each([
    [
      "1440×900",
      1440 / 836,
      { left: 0.3, top: 72 / 836, right: 1416 / 1440, bottom: 764 / 836 },
    ],
    [
      "1920×1080",
      1448 / 1016,
      {
        left: 440 / 1448,
        top: 86.4 / 1016,
        right: 1424 / 1448,
        bottom: 929.6 / 1016,
      },
    ],
    [
      "3840×2160",
      1448 / 2096,
      {
        left: 440 / 1448,
        top: 96 / 2096,
        right: 1424 / 1448,
        bottom: 2000 / 2096,
      },
    ],
    ["390×844", 390 / 780, { left: 0, top: 0, right: 1, bottom: 1 }],
  ] as const)(
    "contains and tightly fits every pointer orbit at %s",
    (_size, aspect, viewport) => {
      const fit = fitProjectionDistance(
        viewport,
        (distance) =>
          projectedBounds(orbitMatrices(aspect, distance), PRISM_FRAME_POINTS),
        PRISM_FRONT_Z + 0.1,
        32
      );
      const matrices = orbitMatrices(aspect, fit.distance);
      for (const matrix of matrices) {
        const framed = applyProjectionFraming(matrix, fit.framing);
        for (const point of PRISM_FRAME_POINTS) {
          const [u, v] = project(framed, point);
          expect(u).toBeGreaterThanOrEqual(viewport.left - 1e-5);
          expect(u).toBeLessThanOrEqual(viewport.right + 1e-5);
          expect(v).toBeGreaterThanOrEqual(viewport.top - 1e-5);
          expect(v).toBeLessThanOrEqual(viewport.bottom + 1e-5);
        }
      }

      const widthFill =
        (fit.bounds.x1 - fit.bounds.x0) /
        ((viewport.right - viewport.left) * 2);
      const heightFill =
        (fit.bounds.y1 - fit.bounds.y0) /
        ((viewport.bottom - viewport.top) * 2);
      expect(Math.max(widthFill, heightFill)).toBeCloseTo(1, 5);

      const framedCenterX =
        (fit.bounds.x0 + fit.bounds.x1) / 2 + fit.framing.offset[0];
      const framedCenterY =
        (fit.bounds.y0 + fit.bounds.y1) / 2 + fit.framing.offset[1];
      expect(framedCenterX).toBeCloseTo(viewport.left + viewport.right - 1, 6);
      expect(framedCenterY).toBeCloseTo(1 - viewport.top - viewport.bottom, 6);
    }
  );

  test("expands coverage rather than exposing the shifted wall", () => {
    expect(framingCoverage({ scale: 0.8, offset: [0.4, -0.1] })).toEqual([
      1.7499999999999998, 1.375,
    ]);
    expect(framingCoverage({ scale: 1, offset: [0, 0] })).toEqual([1, 1]);
  });
});

function orbitMatrices(aspect: number, distance: number): Float32Array[] {
  const matrices: Float32Array[] = [];
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      matrices.push(cameraView(aspect, x, y, distance).viewProjection);
    }
  }
  return matrices;
}

function project(
  matrix: Float32Array,
  point: readonly [number, number, number]
): readonly [number, number] {
  const [x, y, z] = point;
  const clipX = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!;
  const clipY = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!;
  const clipW = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
  return [(clipX / clipW) * 0.5 + 0.5, 0.5 - (clipY / clipW) * 0.5];
}
