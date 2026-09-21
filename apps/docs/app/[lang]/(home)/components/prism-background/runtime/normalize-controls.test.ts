import { expect, test } from "vitest";

import { DEFAULT_PRISM_CONTROLS, type PrismControls } from "../types";
import { normalizeControls } from "./normalize-controls";

test("keeps dark absorption while light glass defaults to no absorption", () => {
  const normalized = normalizeControls(DEFAULT_PRISM_CONTROLS);

  expect(normalized.glass.transmission).toEqual({
    dark: { ior: 1.645, absorption: [1, 1, 0.54] },
    light: { ior: 1.645, absorption: [0, 0, 0] },
  });
});

test("migrates legacy glass transmission into dark mode only", () => {
  const legacyControls = {
    ...DEFAULT_PRISM_CONTROLS,
    glass: {
      ior: 1.72,
      absorption: [0.2, 0.15, 0.1],
      reflectionStrength: 1.4,
      environmentExposure: 1.8,
    },
  } as unknown as PrismControls;

  expect(normalizeControls(legacyControls).glass).toEqual({
    transmission: {
      dark: { ior: 1.72, absorption: [0.2, 0.15, 0.1] },
      light: { ior: 1.645, absorption: [0, 0, 0] },
    },
    reflection: {
      dark: { reflectionStrength: 1.4, environmentExposure: 1.8 },
      light: { reflectionStrength: 3, environmentExposure: 4 },
    },
  });
});

test("preserves independently customized transmission in both themes", () => {
  const controls: PrismControls = {
    ...DEFAULT_PRISM_CONTROLS,
    glass: {
      ...DEFAULT_PRISM_CONTROLS.glass,
      transmission: {
        dark: { ior: 1.81, absorption: [0.7, 0.6, 0.5] },
        light: { ior: 1.47, absorption: [0.1, 0.05, 0] },
      },
    },
  };

  expect(normalizeControls(controls).glass.transmission).toEqual(
    controls.glass.transmission
  );
});

test("preserves independently customized reflections in both themes", () => {
  const controls: PrismControls = {
    ...DEFAULT_PRISM_CONTROLS,
    glass: {
      ...DEFAULT_PRISM_CONTROLS.glass,
      reflection: {
        dark: { reflectionStrength: 1.4, environmentExposure: 1.8 },
        light: { reflectionStrength: 2.8, environmentExposure: 3.5 },
      },
    },
  };

  expect(normalizeControls(controls).glass.reflection).toEqual(
    controls.glass.reflection
  );
});

test("fills missing light-mode look controls during Fast Refresh", () => {
  const legacy = {
    ...DEFAULT_PRISM_CONTROLS,
    lightMode: undefined,
  } as unknown as PrismControls;
  expect(normalizeControls(legacy).lightMode).toEqual(
    DEFAULT_PRISM_CONTROLS.lightMode
  );
});

test("clamps light-mode look controls to their authored ranges", () => {
  const controls = {
    ...DEFAULT_PRISM_CONTROLS,
    lightMode: {
      wall: {
        normalStrength: 99,
        lightmapGamma: -1,
        shadowContrast: 99,
        shadowPivot: -1,
        shadowFloor: -1,
        highlightExposure: 99,
        ambientFill: 99,
      },
      caustic: {
        strength: 99,
        coverage: -1,
        normalInfluence: 99,
        normalElevation: -1,
      },
      output: { exposure: 99, toneMapping: "invalid" },
    },
  } as unknown as PrismControls;

  expect(normalizeControls(controls).lightMode).toEqual({
    wall: {
      normalStrength: 3,
      lightmapGamma: 0.5,
      shadowContrast: 8,
      shadowPivot: 0.05,
      shadowFloor: 0,
      highlightExposure: 8,
      ambientFill: 2.5,
    },
    caustic: {
      strength: 4,
      coverage: 0,
      normalInfluence: 1,
      normalElevation: 5,
    },
    output: { exposure: 2, toneMapping: "aces" },
  });
});
