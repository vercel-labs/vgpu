import { reflectSource } from "@vgpu/wgsl/reflect-source";
import { describe, expect, test } from "vitest";

import glassBackWgsl from "./glass-back.wgsl";
import glassCommonWgsl from "./glass-common.wgsl";
import glassWgsl from "./glass.wgsl";
import glassAccentWgsl from "../../light/passes/glass-accent/glass-accent.wgsl";
import { prismPlanes } from "../../../scene/prism-mesh";
import { schlickFresnelF0 } from "../../../runtime/uniforms";
import {
  PRISM_BACK_Z,
  PRISM_FRONT_Z,
  PRISM_TRIANGLE,
  type Vec2,
} from "../../../types";

type Vec3 = readonly [number, number, number];
type Plane = readonly [number, number, number, number];

describe("static glass optics", () => {
  test("uploads the five planes in the shader's exact hit-test order", () => {
    const uploaded = prismPlanes();
    const legacy = legacyPlanes();
    expect(uploaded).toHaveLength(5);
    uploaded.forEach((plane, index) =>
      expect(plane).toEqual(legacy[index])
    );

    const origins: Vec3[] = [
      [0, 0, (PRISM_BACK_Z + PRISM_FRONT_Z) * 0.5],
      [PRISM_TRIANGLE.a[0] * 0.25, PRISM_TRIANGLE.a[1] * 0.25, 0.08],
      [PRISM_TRIANGLE.b[0] * 0.2, PRISM_TRIANGLE.b[1] * 0.2, 0.27],
    ];
    const directions: Vec3[] = [];
    for (let z = -2; z <= 2; z++) {
      for (let y = -2; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) {
          if (x || y || z) directions.push(normalize3([x, y, z]));
        }
      }
    }

    for (const origin of origins) {
      for (const direction of directions) {
        const before = nearestHit(origin, direction, legacyHitOrder(legacy));
        const after = nearestHit(origin, direction, uploadedHitOrder(uploaded));
        expect(after.distance).toBeCloseTo(before.distance, 12);
        expect(after.normal).toEqual(before.normal);
      }
    }
  });

  test("precomputed Schlick F0 and multiply-only fifth power match the old formula", () => {
    for (const ior of [1, 1.1, 1.47, 1.645, 1.72, 2.5]) {
      const f0 = schlickFresnelF0(ior);
      expect(f0).toBeCloseTo(((ior - 1) / (ior + 1)) ** 2, 7);
      for (let sample = 0; sample <= 128; sample++) {
        const facing = sample / 128;
        const x = 1 - facing;
        const squared = x * x;
        const optimized = f0 + (1 - f0) * squared * squared * x;
        const legacy =
          ((ior - 1) / (ior + 1)) ** 2 +
          (1 - ((ior - 1) / (ior + 1)) ** 2) * Math.pow(x, 5);
        expect(Math.abs(optimized - legacy)).toBeLessThan(2e-7);
      }
    }
  });

  test("keeps one identical 304-byte Glass layout in every material", () => {
    const layouts = [glassWgsl, glassBackWgsl, glassAccentWgsl].map(
      ({ wgsl }) =>
        reflectSource(wgsl).bindings.find(({ name }) => name === "params")
          ?.layout
    );
    for (const layout of layouts) {
      expect(layout?.size).toBe(304);
      const fields = Object.fromEntries(
        layout?.members?.map((member) => [member.name, member]) ?? []
      );
      expect(fields.fresnelF0).toMatchObject({ offset: 220, size: 4 });
      expect(fields.prismPlanes).toMatchObject({
        offset: 224,
        size: 80,
        layout: { stride: 16, size: 80 },
      });
    }
    expect(glassCommonWgsl.wgsl).not.toContain("pow(1.0 - clamp(facing");
    expect(glassWgsl.wgsl).not.toContain("normalize(vec2f(edge.y");
    expect(glassBackWgsl.wgsl).not.toContain("normalize(vec2f(edge.y");
  });
});

function legacyPlanes(): readonly Plane[] {
  const corners = [PRISM_TRIANGLE.a, PRISM_TRIANGLE.b, PRISM_TRIANGLE.c];
  const sides = corners.map((start, index): Plane => {
    const end = corners[(index + 1) % corners.length]!;
    const edge: Vec2 = [end[0] - start[0], end[1] - start[1]];
    const length = Math.hypot(edge[0], edge[1]);
    const normal: Vec2 = [edge[1] / length, -edge[0] / length];
    return [
      normal[0],
      normal[1],
      0,
      normal[0] * start[0] + normal[1] * start[1],
    ];
  });
  return [
    ...sides,
    [0, 0, 1, PRISM_FRONT_Z],
    [0, 0, -1, -PRISM_BACK_Z],
  ];
}

function legacyHitOrder(planes: readonly Plane[]): readonly Plane[] {
  return [planes[3]!, planes[4]!, planes[0]!, planes[1]!, planes[2]!];
}

function uploadedHitOrder(planes: readonly Plane[]): readonly Plane[] {
  return [planes[3]!, planes[4]!, ...planes.slice(0, 3)];
}

function nearestHit(
  origin: Vec3,
  direction: Vec3,
  planes: readonly Plane[]
): { readonly distance: number; readonly normal: Vec3 } {
  let distance = Number.POSITIVE_INFINITY;
  let normal: Vec3 = planes[0]!.slice(0, 3) as unknown as Vec3;
  for (const plane of planes) {
    const denominator = dot3(plane, direction);
    if (denominator <= 0.00001) continue;
    const candidate =
      (plane[3] - dot3(plane, origin)) / denominator;
    if (candidate > 0.0001 && candidate < distance) {
      distance = candidate;
      normal = [plane[0], plane[1], plane[2]];
    }
  }
  return { distance, normal };
}

function dot3(a: readonly number[], b: Vec3): number {
  return a[0]! * b[0] + a[1]! * b[1] + a[2]! * b[2];
}

function normalize3(value: Vec3): Vec3 {
  const length = Math.hypot(...value);
  return [value[0] / length, value[1] / length, value[2] / length];
}
