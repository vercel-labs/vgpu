import * as d from 'typegpu/data';
import { expect, test } from 'vitest';

import { initialParticles, Particle, simulationWgsl } from './dust';
import { DUST_COUNT } from './pipeline';

test('particle layout matches the WGSL struct the star shader declares', () => {
  // stars.wgsl declares { position: vec2f, velocity: vec2f, seed: f32,
  // energy: f32, tint: vec3f } by hand; the TypeGPU schema must agree byte
  // for byte.
  expect(d.sizeOf(Particle)).toBe(48);
  expect(d.alignmentOf(Particle)).toBe(16);
});

test('the resolved compute shader carries the generated declarations', () => {
  const wgsl = simulationWgsl();
  expect(wgsl).toContain('struct Particle');
  expect(wgsl).toContain('struct SimParams');
  expect(wgsl).toContain('var<storage, read_write> particles: array<Particle>');
  expect(wgsl).toContain('fn orbit');
  expect(wgsl).toContain('textureSampleLevel');
});

test('seeding is deterministic and bounded', () => {
  const first = initialParticles();
  const second = initialParticles();
  expect(first).toHaveLength(DUST_COUNT);
  expect(first).toEqual(second);
  for (const particle of first) {
    const radius = Math.hypot(particle.position.x, particle.position.y);
    expect(radius).toBeGreaterThanOrEqual(70);
    expect(radius).toBeLessThanOrEqual(260);
    expect(particle.energy).toBe(0);
    expect(particle.tint).toEqual(d.vec3f(0, 0, 0));
  }
});
