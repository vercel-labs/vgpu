import {
  PRISM_DISPERSION_PRESETS,
  type GlassReflectionControls,
  type GlassTransmissionControls,
  type LightFadeControls,
  type LightCausticControls,
  type LightOutputControls,
  type LightWallControls,
  type PostprocessControls,
  type PrismControls,
  type PrismDispersion,
  type PrismTheme,
} from "../../types";

export function withCameraFov(
  controls: PrismControls,
  cameraFov: number
): PrismControls {
  return { ...controls, cameraFov };
}

export function withWallColor(
  controls: PrismControls,
  wallColor: string
): PrismControls {
  return { ...controls, wallColor };
}

export function withBeamWidth(
  controls: PrismControls,
  beamWidth: number
): PrismControls {
  return { ...controls, beamWidth };
}

export function withBeamMouseY(
  controls: PrismControls,
  edge: keyof PrismControls["beamMouseY"],
  value: number
): PrismControls {
  return {
    ...controls,
    beamMouseY: { ...controls.beamMouseY, [edge]: value },
  };
}

export function withLightFade(
  controls: PrismControls,
  field: keyof LightFadeControls,
  value: number
): PrismControls {
  return {
    ...controls,
    lightFade: { ...controls.lightFade, [field]: value },
  };
}

export function withLightWall(
  controls: PrismControls,
  field: keyof LightWallControls,
  value: number
): PrismControls {
  return {
    ...controls,
    lightMode: {
      ...controls.lightMode,
      wall: { ...controls.lightMode.wall, [field]: value },
    },
  };
}

export function withLightCaustic(
  controls: PrismControls,
  field: keyof LightCausticControls,
  value: number
): PrismControls {
  return {
    ...controls,
    lightMode: {
      ...controls.lightMode,
      caustic: { ...controls.lightMode.caustic, [field]: value },
    },
  };
}

export function withLightOutput<Field extends keyof LightOutputControls>(
  controls: PrismControls,
  field: Field,
  value: LightOutputControls[Field]
): PrismControls {
  return {
    ...controls,
    lightMode: {
      ...controls.lightMode,
      output: { ...controls.lightMode.output, [field]: value },
    },
  };
}

export function withDispersionPreset(
  controls: PrismControls,
  dispersion: PrismDispersion
): PrismControls {
  return {
    ...controls,
    dispersion,
    spectralDispersion: { ...PRISM_DISPERSION_PRESETS[dispersion] },
  };
}

export function withSpectralDispersion(
  controls: PrismControls,
  field: "base" | "strength",
  value: number
): PrismControls {
  const current =
    controls.spectralDispersion ??
    PRISM_DISPERSION_PRESETS[controls.dispersion];
  return {
    ...controls,
    spectralDispersion: { ...current, [field]: value },
  };
}

export function withTransmission(
  controls: PrismControls,
  mode: PrismTheme,
  patch: Partial<GlassTransmissionControls>
): PrismControls {
  return {
    ...controls,
    glass: {
      ...controls.glass,
      transmission: {
        ...controls.glass.transmission,
        [mode]: { ...controls.glass.transmission[mode], ...patch },
      },
    },
  };
}

export function withAbsorption(
  controls: PrismControls,
  mode: PrismTheme,
  channel: 0 | 1 | 2,
  value: number
): PrismControls {
  const absorption = [...controls.glass.transmission[mode].absorption] as [
    number,
    number,
    number
  ];
  absorption[channel] = value;
  return withTransmission(controls, mode, { absorption });
}

export function withReflection(
  controls: PrismControls,
  mode: PrismTheme,
  field: keyof GlassReflectionControls,
  value: number
): PrismControls {
  return {
    ...controls,
    glass: {
      ...controls.glass,
      reflection: {
        ...controls.glass.reflection,
        [mode]: { ...controls.glass.reflection[mode], [field]: value },
      },
    },
  };
}

export function withPostprocess(
  controls: PrismControls,
  field: keyof PostprocessControls,
  value: number
): PrismControls {
  return {
    ...controls,
    postprocess: { ...controls.postprocess, [field]: value },
  };
}
