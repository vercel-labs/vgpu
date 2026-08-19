import { describe, expect, test } from "vitest";

import { buildLightMesh, LIGHT_VERTEX_FLOATS, lightVertexCount, traceSpectralBand } from "./light-mesh";
import {
  PRISM_DISPERSION_PRESETS,
  PRISM_LIGHT,
  PRISM_SPECTRAL_SAMPLES,
  PRISM_TRIANGLE,
  PRISM_WAVELENGTHS,
  type Vec2,
} from "./types";

const angle = (direction: Vec2): number => Math.atan2(direction[1], direction[0]);
const defaultOptions = {
  light: PRISM_LIGHT,
  dispersion: PRISM_DISPERSION_PRESETS.stylized,
  wallHalfExtent: [1.5, 1] as const,
};

describe("finite spectral beam", () => {
  test("keeps a non-zero width through the prism instead of focusing to a point", () => {
    const band = traceSpectralBand(PRISM_TRIANGLE, PRISM_LIGHT, PRISM_DISPERSION_PRESETS.stylized, 550);
    expect(band).toBeDefined();
    expect(band!.outputWidth).toBeGreaterThan(PRISM_LIGHT.beamHalfWidth);
    expect(band!.lower.origin).not.toEqual(band!.upper.origin);
  });

  test("preserves the expected violet-to-red angular ordering", () => {
    const violet = traceSpectralBand(
      PRISM_TRIANGLE,
      PRISM_LIGHT,
      PRISM_DISPERSION_PRESETS.stylized,
      PRISM_WAVELENGTHS.min,
    )!;
    const red = traceSpectralBand(
      PRISM_TRIANGLE,
      PRISM_LIGHT,
      PRISM_DISPERSION_PRESETS.stylized,
      PRISM_WAVELENGTHS.max,
    )!;
    expect(angle(violet.lower.direction)).toBeLessThan(angle(red.lower.direction));
  });

  test("uses fixed-size GPU geometry and accepts the whole default spectrum", () => {
    const mesh = buildLightMesh(defaultOptions);
    expect(mesh.vertexCount).toBe(lightVertexCount(PRISM_SPECTRAL_SAMPLES));
    expect(mesh.stats.validBands).toBe(PRISM_SPECTRAL_SAMPLES);
    expect(mesh.stats.rejectedTopology).toBe(0);
    expect(mesh.stats.minOutputWidth).toBeGreaterThan(0.01);
  });

  test("integrated flux is stable when wavelength subdivision changes", () => {
    const coarse = buildLightMesh({ ...defaultOptions, samples: 32 });
    const fine = buildLightMesh({ ...defaultOptions, samples: 128 });
    expect(coarse.stats.totalFlux).toBeCloseTo(fine.stats.totalFlux, 3);
  });

  test("connects neighbouring wavelengths in each spectral mesh cell", () => {
    const mesh = buildLightMesh({
      ...defaultOptions,
      samples: 3,
      beamSlices: 1,
    });
    const spectralVertexCount = 2 * 6;
    const firstCell = (mesh.vertexCount - spectralVertexCount) * LIGHT_VERTEX_FLOATS;
    const wavelengths = Array.from(
      { length: 6 },
      (_, vertex) => mesh.vertices[firstCell + vertex * LIGHT_VERTEX_FLOATS + 2],
    );
    expect(wavelengths).toEqual([400, 550, 550, 400, 550, 400]);
  });
});
