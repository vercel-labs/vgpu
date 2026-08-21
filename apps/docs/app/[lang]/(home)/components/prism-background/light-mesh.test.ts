import { describe, expect, test } from "vitest";

import {
  buildLightMesh,
  beamIntersectsTriangle,
  INPUT_BEAM_RADIANCE,
  LIGHT_VERTEX_FLOATS,
  lightVertexCount,
  traceSpectralBand,
} from "./light-mesh";
import { wavelengthToLinearRgb } from "./optics";
import {
  PRISM_DISPERSION_PRESETS,
  PRISM_CENTROID,
  DEFAULT_POSTPROCESS_CONTROLS,
  PRISM_INCIDENCE_DEGREES,
  PRISM_LIGHT,
  PRISM_SPECTRAL_SAMPLES,
  PRISM_TRIANGLE,
  PRISM_WAVELENGTHS,
  collimatedLightBetween,
  lampForIncidence,
  type Vec2,
} from "./types";

const angle = (direction: Vec2): number =>
  Math.atan2(direction[1], direction[0]);
const defaultOptions = {
  light: PRISM_LIGHT,
  dispersion: PRISM_DISPERSION_PRESETS.stylized,
  wallHalfExtent: [1.5, 1] as const,
};

describe("finite spectral beam", () => {
  test("traces a source aimed through any prism face", () => {
    const vertices = [PRISM_TRIANGLE.a, PRISM_TRIANGLE.b, PRISM_TRIANGLE.c] as const;
    for (let edgeIndex = 0; edgeIndex < vertices.length; edgeIndex++) {
      const start = vertices[edgeIndex]!;
      const end = vertices[(edgeIndex + 1) % vertices.length]!;
      const midpoint: Vec2 = [(start[0] + end[0]) * 0.5, (start[1] + end[1]) * 0.5];
      const outwardLength = Math.hypot(
        midpoint[0] - PRISM_CENTROID[0],
        midpoint[1] - PRISM_CENTROID[1]
      );
      const source: Vec2 = [
        midpoint[0] + ((midpoint[0] - PRISM_CENTROID[0]) / outwardLength) * 2,
        midpoint[1] + ((midpoint[1] - PRISM_CENTROID[1]) / outwardLength) * 2,
      ];
      const mesh = buildLightMesh({
        ...defaultOptions,
        light: collimatedLightBetween(source, PRISM_CENTROID),
        samples: 16,
        beamSlices: 4,
      });
      expect(mesh.stats.validBands, `entry edge ${edgeIndex}`).toBe(16);
      expect(mesh.stats.rejectedTopology, `entry edge ${edgeIndex}`).toBe(0);
    }
  });

  test("continues an uninterrupted white beam when it misses the prism", () => {
    const light = collimatedLightBetween([-2, 0.8], [2, 0.8], 0.04);
    expect(beamIntersectsTriangle(PRISM_TRIANGLE, light)).toBe(false);
    const mesh = buildLightMesh({
      ...defaultOptions,
      light,
      samples: 3,
      beamSlices: 1,
    });
    const positions = Array.from({ length: 6 }, (_, vertex) => [
      mesh.vertices[vertex * LIGHT_VERTEX_FLOATS],
      mesh.vertices[vertex * LIGHT_VERTEX_FLOATS + 1],
    ]);
    const expected = [
      [-1.5, 0.78],
      [-1.5, 0.82],
      [1.5, 0.82],
      [-1.5, 0.78],
      [1.5, 0.82],
      [1.5, 0.78],
    ];
    positions.forEach((position, index) => {
      expect(position[0]).toBeCloseTo(expected[index]![0]!, 6);
      expect(position[1]).toBeCloseTo(expected[index]![1]!, 6);
    });
    expect(mesh.stats.validBands).toBe(0);

    const insideSource = buildLightMesh({
      ...defaultOptions,
      light: collimatedLightBetween([0, 0.8], [1, 0.8], 0.04),
      samples: 3,
      beamSlices: 1,
    });
    expect(insideSource.vertices[0]).toBeCloseTo(0, 6);
    expect(insideSource.vertices[2 * LIGHT_VERTEX_FLOATS]).toBeCloseTo(1.5, 6);
  });

  test("keeps a non-zero width through the prism instead of focusing to a point", () => {
    const band = traceSpectralBand(
      PRISM_TRIANGLE,
      PRISM_LIGHT,
      PRISM_DISPERSION_PRESETS.stylized,
      550
    );
    expect(band).toBeDefined();
    expect(band!.outputWidth).toBeGreaterThan(PRISM_LIGHT.beamHalfWidth);
    expect(band!.lower.origin).not.toEqual(band!.upper.origin);
  });

  test("widens the refracted footprint when the configured beam gets wider", () => {
    const narrow = traceSpectralBand(
      PRISM_TRIANGLE,
      lampForIncidence(PRISM_INCIDENCE_DEGREES, 0.04),
      PRISM_DISPERSION_PRESETS.stylized,
      550
    )!;
    const wide = traceSpectralBand(
      PRISM_TRIANGLE,
      lampForIncidence(PRISM_INCIDENCE_DEGREES, 0.14),
      PRISM_DISPERSION_PRESETS.stylized,
      550
    )!;
    expect(wide.outputWidth).toBeGreaterThan(narrow.outputWidth * 3);
  });

  test("preserves the expected violet-to-red angular ordering", () => {
    const violet = traceSpectralBand(
      PRISM_TRIANGLE,
      PRISM_LIGHT,
      PRISM_DISPERSION_PRESETS.stylized,
      PRISM_WAVELENGTHS.min
    )!;
    const red = traceSpectralBand(
      PRISM_TRIANGLE,
      PRISM_LIGHT,
      PRISM_DISPERSION_PRESETS.stylized,
      PRISM_WAVELENGTHS.max
    )!;
    expect(angle(violet.lower.direction)).toBeGreaterThan(
      angle(red.lower.direction)
    );
  });

  test("uses fixed-size GPU geometry and accepts the whole default spectrum", () => {
    const mesh = buildLightMesh(defaultOptions);
    expect(mesh.vertexCount).toBe(lightVertexCount(PRISM_SPECTRAL_SAMPLES));
    expect(mesh.stats.validBands).toBe(PRISM_SPECTRAL_SAMPLES);
    expect(mesh.stats.rejectedTopology).toBe(0);
    expect(mesh.stats.minOutputWidth).toBeGreaterThan(
      PRISM_LIGHT.beamHalfWidth
    );
  });

  test("integrated flux is stable when wavelength subdivision changes", () => {
    const coarse = buildLightMesh({ ...defaultOptions, samples: 32 });
    const fine = buildLightMesh({ ...defaultOptions, samples: 128 });
    expect(coarse.stats.totalFlux).toBeCloseTo(fine.stats.totalFlux, 3);
  });

  test("puts the rainbow above the bloom threshold but below the white source", () => {
    const mesh = buildLightMesh(defaultOptions);
    const radiances: number[] = [];
    for (
      let offset = 0;
      offset < mesh.vertices.length;
      offset += LIGHT_VERTEX_FLOATS
    ) {
      const wavelength = mesh.vertices[offset + 2]!;
      if (wavelength >= 0) {
        const intensity = mesh.vertices[offset + 4]!;
        radiances.push(
          intensity * Math.max(...wavelengthToLinearRgb(wavelength))
        );
      }
    }
    const maxRadiance = Math.max(...radiances);
    expect(maxRadiance).toBeGreaterThan(
      DEFAULT_POSTPROCESS_CONTROLS.bloomThreshold
    );
    expect(maxRadiance).toBeLessThan(INPUT_BEAM_RADIANCE * 0.4);
  });

  test("connects neighbouring wavelengths in each spectral mesh cell", () => {
    const mesh = buildLightMesh({
      ...defaultOptions,
      samples: 3,
      beamSlices: 1,
    });
    const spectralVertexCount = 2 * 6;
    const firstCell =
      (mesh.vertexCount - spectralVertexCount) * LIGHT_VERTEX_FLOATS;
    const wavelengths = Array.from(
      { length: 6 },
      (_, vertex) => mesh.vertices[firstCell + vertex * LIGHT_VERTEX_FLOATS + 2]
    );
    expect(wavelengths).toEqual([400, 550, 550, 400, 550, 400]);
  });

  test("keeps the collimated source constant while fading the outgoing spectrum", () => {
    const mesh = buildLightMesh({
      ...defaultOptions,
      samples: 3,
      beamSlices: 1,
    });
    const attribute = (vertex: number, offset: number) =>
      mesh.vertices[vertex * LIGHT_VERTEX_FLOATS + offset];

    // A collimated source does not lose radiance over this scene-scale distance.
    expect(
      Array.from({ length: 6 }, (_, vertex) => attribute(vertex, 5))
    ).toEqual([0, 0, 0, 0, 0, 0]);

    // Every outgoing spectral cell starts at the glass and fades toward its cap.
    const spectralStart = mesh.vertexCount - 12;
    expect(
      Array.from({ length: 6 }, (_, vertex) =>
        attribute(spectralStart + vertex, 5)
      )
    ).toEqual([0, 0, 1, 0, 1, 1]);
  });

});
