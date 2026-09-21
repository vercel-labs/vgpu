import {
  clamp01,
  fbm,
  segmentDistance,
  triangleContains,
  triangleDistance,
  writePixel,
} from "./math";
import type { GeneratedLightAsset } from "./types";
import {
  PRISM_CENTROID,
  PRISM_SIDE,
  PRISM_TRIANGLE,
  type Vec2,
} from "../../../types";

function groundingPoint(point: Vec2): Vec2 {
  return [
    (point[0] - PRISM_CENTROID[0]) / PRISM_SIDE,
    (PRISM_CENTROID[1] - point[1]) / PRISM_SIDE,
  ];
}

/** Exact prism footprint in the wall-lighting texture's local coordinate space. */
export const PRISM_GROUNDING_TRIANGLE = Object.freeze([
  groundingPoint(PRISM_TRIANGLE.a),
  groundingPoint(PRISM_TRIANGLE.b),
  groundingPoint(PRISM_TRIANGLE.c),
] as const);

export const PRISM_GROUNDING_AO = Object.freeze({
  insideSpread: 0.0015,
  outsideSpread: 0.014,
  opacity: 0.075,
});

function plasterHeight(u: number, v: number): number {
  return fbm(u * 34, v * 34, 5) * 0.65 + fbm(u * 117, v * 117, 2) * 0.35;
}

export function generateWallMaterial(
  size: readonly [number, number]
): GeneratedLightAsset {
  const [width, height] = size;
  const pixels = new Uint8Array(width * height * 4);
  const epsilon = 1 / Math.max(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const v = (y + 0.5) / height;
      const heightX =
        plasterHeight(u + epsilon, v) - plasterHeight(u - epsilon, v);
      const heightY =
        plasterHeight(u, v + epsilon) - plasterHeight(u, v - epsilon);
      const variation = plasterHeight(u, v) - 0.5;
      writePixel(pixels, (y * width + x) * 4, [
        0.8 + variation * 0.06,
        0.5 - heightX * 1.8,
        0.5 - heightY * 1.8,
        0.86 + variation * 0.12,
      ]);
    }
  }
  return { width, height, pixels };
}

function softBlob(
  u: number,
  v: number,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number
): number {
  const dx = (u - centerX) / radiusX;
  const dy = (v - centerY) / radiusY;
  return Math.exp(-(dx * dx + dy * dy) * 1.8);
}

function overheadLight(u: number, v: number): number {
  const upperLeft = softBlob(u, v, -0.08, -0.08, 0.58, 0.64) * 0.75;
  const center = softBlob(u, v, 0.42, 0.22, 0.15, 0.17) * 0.7;
  const right = softBlob(u, v, 0.83, 0.3, 0.16, 0.18) * 0.6;
  return clamp01(upperLeft + center + right);
}

function grounding(x: number, y: number): readonly [number, number] {
  const [, left, right] = PRISM_GROUNDING_TRIANGLE;
  const base = segmentDistance(x, y, left[0], left[1], right[0], right[1]);
  const baseContact = Math.exp(-(base * base) / 0.00135);
  const edge = triangleDistance(x, y, PRISM_GROUNDING_TRIANGLE);
  const edgeSpread = triangleContains(x, y, PRISM_GROUNDING_TRIANGLE)
    ? PRISM_GROUNDING_AO.insideSpread
    : PRISM_GROUNDING_AO.outsideSpread;
  const edgeOcclusion = Math.exp(-(edge * edge) / edgeSpread);
  const shadow = clamp01(1 - baseContact * 0.15);
  const ao = clamp01(
    1 - edgeOcclusion * PRISM_GROUNDING_AO.opacity - baseContact * 0.25
  );
  return [shadow, ao];
}

export function generateWallLighting(
  size: readonly [number, number]
): GeneratedLightAsset {
  const [width, height] = size;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const v = (y + 0.5) / height;
      const localX = u * 2 - 1;
      const localY = v * 2 - 1;
      const [prismShadow, ao] = grounding(localX, localY);
      writePixel(pixels, (y * width + x) * 4, [
        overheadLight(u, v),
        prismShadow,
        ao,
        1,
      ]);
    }
  }
  return { width, height, pixels };
}
