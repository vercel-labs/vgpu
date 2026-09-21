import { expect, test } from "vitest";

import {
  createInitialParticles,
  isEarthLand,
  PARTICLE_FLOATS,
} from "./simulation";

test("particle initialization is deterministic for a fixed seed", () => {
  const first = createInitialParticles(8, 42);
  const second = createInitialParticles(8, 42);
  const other = createInitialParticles(8, 43);
  expect(first).toEqual(second);
  expect(first).not.toEqual(other);
  expect(first).toHaveLength(8 * PARTICLE_FLOATS);
});

test("procedural continent silhouettes separate familiar land and ocean points", () => {
  expect(isEarthLand(-1.75, 0.7)).toBe(true);
  expect(isEarthLand(-1.15, -0.45)).toBe(true);
  expect(isEarthLand(0.15, 0)).toBe(true);
  expect(isEarthLand(2.2, -0.65)).toBe(true);
  expect(isEarthLand(-0.75, 0.25)).toBe(false);
  expect(isEarthLand(-2.5, -0.5)).toBe(false);
});

test("initial particles form a narrow spherical shell with zero velocity", () => {
  const particles = createInitialParticles(32, 7);
  for (let i = 0; i < 32; i++) {
    const offset = i * PARTICLE_FLOATS;
    const radius = Math.hypot(
      particles[offset]!,
      particles[offset + 1]!,
      particles[offset + 2]!
    );
    expect(radius).toBeGreaterThanOrEqual(0.9699);
    expect(radius).toBeLessThanOrEqual(1.0001);
    expect([...particles.slice(offset + 4, offset + 8)]).toEqual([0, 0, 0, 0]);
  }
});
