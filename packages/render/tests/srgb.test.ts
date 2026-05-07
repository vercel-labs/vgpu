import { expect, test } from "vitest";
import { srgb } from "@vgpu/render";

test("converts black hex to linear black", () => {
  expect(srgb(0x000000)).toEqual([0, 0, 0]);
});

test("converts white hex to linear white", () => {
  const color = srgb(0xffffff);
  expect(color[0]).toBeCloseTo(1, 12);
  expect(color[1]).toBeCloseTo(1, 12);
  expect(color[2]).toBeCloseTo(1, 12);
});

test("converts orange hex to linear color", () => {
  const color = srgb(0xff6600);
  expect(color[0]).toBeCloseTo(1, 5);
  expect(color[1]).toBeCloseTo(0.13287, 5);
  expect(color[2]).toBe(0);
});

test("converts sRGB component triples to linear color", () => {
  const color = srgb([0.5, 0.5, 0.5]);
  expect(color[0]).toBeCloseTo(0.21404, 5);
  expect(color[1]).toBeCloseTo(0.21404, 5);
  expect(color[2]).toBeCloseTo(0.21404, 5);
});

test("keeps zero component triples finite", () => {
  const color = srgb([0, 0, 0]);
  expect(color).toEqual([0, 0, 0]);
  expect(color.every(Number.isFinite)).toBe(true);
});
