import { describe, expect, test } from "vitest";
import { effect, frame, init, target } from "vgpu/node";

import shader from "./fixtures/ray-footprint-probe.wgsl";

type Vec3 = [number, number, number];


describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("glass ray footprint GPU", () => {
  test("matches finite differences through reflection, refraction, bevel normals and TIR", async () => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: [6, 1], format: "rgba32float" });
      const probe = effect(gpu, shader);
      await probe.compile(output);
      for (const eta of [1 / 1.645, 1.645]) {
        // Include normal incidence, near-critical transmission and TIR.
        for (const angle of [0, 0.35, Math.asin(1 / 1.645) - 0.01, 0.9]) {
          for (const bevel of [false, true]) {
            const incident: Vec3 = [Math.sin(angle), -Math.cos(angle), 0];
            const normal: Vec3 = [0, 1, 0];
            const incidentDx: Vec3 = [Math.cos(angle) * 0.002, Math.sin(angle) * 0.002, 0];
            const incidentDy: Vec3 = [0, 0, 0.003];
            const normalDx: Vec3 = bevel ? [0.004, 0, 0] : [0, 0, 0];
            const normalDy: Vec3 = bevel ? [0, 0, 0.005] : [0, 0, 0];
            probe.set({ inputs: { incident, incidentDx, incidentDy, normal, normalDx, normalDy, eta } });
            frame(gpu, (current) => current.pass({ target: output }, (pass) => pass.draw(probe)));
            const pixels = await output.color.readFloats({ mipLevel: 0, region: "all" });
            for (const [operation, offset] of [[reflect, 0], [refract, 3]] as const) {
              const reference = operation(incident, normal, eta);
              const derivatives = [[incidentDx, normalDx], [incidentDy, normalDy]].map(([dd, dn]) => {
                const step = 0.001;
                const plus = operation(perturb(incident, dd!, step), perturb(normal, dn!, step), eta);
                const minus = operation(perturb(incident, dd!, -step), perturb(normal, dn!, -step), eta);
                return plus.map((value, channel) => (value - minus[channel]!) / (2 * step));
              });
              [reference, ...derivatives].forEach((expected, field) => {
                expected.forEach((value, channel) => {
                  const actual = pixels[(offset + field) * 4 + channel]!;
                  expect(Number.isFinite(actual)).toBe(true);
                  expect(actual, `eta=${eta}, angle=${angle}, bevel=${bevel}, field=${offset + field}`).toBeCloseTo(value, 5);
                });
              });
            }
          }
        }
      }
    } finally {
      gpu.dispose();
    }
  });
});

function dot(a: Vec3, b: Vec3): number {
  return a.reduce((sum, value, channel) => sum + value * b[channel]!, 0);
}

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(...value);
  return value.map((component) => component / length) as Vec3;
}

function perturb(value: Vec3, delta: Vec3, step: number): Vec3 {
  return normalize(value.map((component, channel) => component + delta[channel]! * step) as Vec3);
}

function reflect(incident: Vec3, normal: Vec3, _eta: number): Vec3 {
  const facing = dot(incident, normal);
  return normalize(incident.map((value, channel) => value - 2 * facing * normal[channel]!) as Vec3);
}

function refract(incident: Vec3, normal: Vec3, eta: number): Vec3 {
  const facing = dot(incident, normal);
  const k = 1 - eta * eta * (1 - facing * facing);
  if (k < 0) return [0, 0, 0];
  return normalize(incident.map((value, channel) => eta * value - (eta * facing + Math.sqrt(k)) * normal[channel]!) as Vec3);
}
