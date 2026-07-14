import { expect, test } from "vitest";
import { degToRad } from "../../src/scene/geometry-src/index.ts";

test("converts zero degrees to zero radians", () => {
  expect(degToRad(0)).toBe(0);
});

test("converts half turn exactly", () => {
  expect(degToRad(180)).toBe(Math.PI);
});

test("converts quarter turn", () => {
  expect(degToRad(90)).toBeCloseTo(Math.PI / 2, 12);
});

test("converts full turn", () => {
  expect(degToRad(360)).toBeCloseTo(Math.PI * 2, 12);
});
