import { describe, expect, test } from "vitest";

import {
  heroRevealProgress,
  presentationRevealUniforms,
} from "./index";

describe("presentation reveal", () => {
  test("starts from each theme's page background", () => {
    expect(presentationRevealUniforms("dark", 0)).toEqual({
      backgroundColor: [0, 0, 0],
      revealProgress: 0,
    });
    expect(presentationRevealUniforms("light", 0)).toEqual({
      backgroundColor: [250 / 255, 250 / 255, 250 / 255],
      revealProgress: 0,
    });
  });

  test("clamps progress without changing a completed presentation", () => {
    expect(presentationRevealUniforms("dark", -1).revealProgress).toBe(0);
    expect(presentationRevealUniforms("light", 2).revealProgress).toBe(1);
  });

  test("opens the beam after quarter opacity and finishes after the fade", () => {
    expect(heroRevealProgress(0)).toEqual({ opacity: 0, beamWidth: 0 });
    const beamStart = 1 - Math.cbrt(0.75);
    expect(heroRevealProgress(beamStart).opacity).toBeCloseTo(0.25);
    expect(heroRevealProgress(beamStart).beamWidth).toBe(0);
    expect(heroRevealProgress(1).opacity).toBe(1);
    expect(heroRevealProgress(1).beamWidth).toBeGreaterThan(0);
    expect(heroRevealProgress(1).beamWidth).toBeLessThan(1);
    const beamMidpoint = beamStart + (2.5 - beamStart) * 0.5;
    expect(heroRevealProgress(beamMidpoint).beamWidth).toBeCloseTo(0.875);
    expect(heroRevealProgress(2.5)).toEqual({ opacity: 1, beamWidth: 1 });
  });
});
