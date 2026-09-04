import {
  PRISM_BEAM_MOUSE_Y_RANGES,
  PRISM_BEAM_WIDTH_RANGE,
  PRISM_CAMERA_RANGES,
  PRISM_DISPERSION_LABELS,
  PRISM_DISPERSION_ORDER,
  PRISM_DISPERSION_PRESETS,
  PRISM_GLASS_RANGES,
  PRISM_LIGHT_FADE_RANGES,
  PRISM_LIGHT_MODE_RANGES,
  PRISM_LIGHT_TONE_MAPPING_LABELS,
  PRISM_LIGHT_TONE_MAPPING_ORDER,
  PRISM_POSTPROCESS_RANGES,
  PRISM_SPECTRAL_DISPERSION_RANGES,
  type PrismDispersion,
  type LightToneMapping,
  type PrismControls,
  type PrismTheme,
} from "../../types";
import type { PrismPipelineQuality } from "../../pipelines/types";
import type { DebugControlGroup, DebugRangeControl } from "./control-types";
import {
  withAbsorption,
  withBeamMouseY,
  withBeamWidth,
  withCameraFov,
  withDispersionPreset,
  withLightFade,
  withLightCaustic,
  withLightOutput,
  withLightWall,
  withPostprocess,
  withReflection,
  withSpectralDispersion,
  withTransmission,
  withWallColor,
} from "./control-updates";

const range = (
  id: string,
  label: string,
  bounds: { readonly min: number; readonly max: number; readonly step: number },
  read: DebugRangeControl["read"],
  write: DebugRangeControl["write"]
): DebugRangeControl => ({ id, label, kind: "range", ...bounds, read, write });

const SCENE_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Camera",
    controls: [
      range(
        "camera-fov",
        "Vertical FOV",
        PRISM_CAMERA_RANGES.fov,
        (controls) => controls.cameraFov,
        (controls, _mode, value) => withCameraFov(controls, value)
      ),
    ],
  },
];

const BEAM_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Beam geometry",
    controls: [
      range(
        "beam-width",
        "Width",
        PRISM_BEAM_WIDTH_RANGE,
        (controls) => controls.beamWidth,
        (controls, _mode, value) => withBeamWidth(controls, value)
      ),
      range(
        "mouse-top",
        "Pointer top (deg)",
        PRISM_BEAM_MOUSE_Y_RANGES.top,
        (controls) => controls.beamMouseY.top,
        (controls, _mode, value) => withBeamMouseY(controls, "top", value)
      ),
      range(
        "mouse-bottom",
        "Pointer bottom (deg)",
        PRISM_BEAM_MOUSE_Y_RANGES.bottom,
        (controls) => controls.beamMouseY.bottom,
        (controls, _mode, value) => withBeamMouseY(controls, "bottom", value)
      ),
    ],
  },
];

const SPECTRAL_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Cauchy dispersion",
    controls: [
      {
        id: "dispersion-preset",
        label: "Glass preset",
        kind: "select",
        options: [
          ...PRISM_DISPERSION_ORDER.map((value) => ({
            value,
            label: PRISM_DISPERSION_LABELS[value],
          })),
          { value: "custom", label: "Custom" },
        ],
        read: matchingDispersionPreset,
        write: (controls, _mode, value) =>
          value === "custom"
            ? controls
            : withDispersionPreset(controls, value as PrismDispersion),
      },
      range(
        "dispersion-base",
        "Base IOR",
        PRISM_SPECTRAL_DISPERSION_RANGES.base,
        (controls) =>
          (
            controls.spectralDispersion ??
            PRISM_DISPERSION_PRESETS[controls.dispersion]
          ).base,
        (controls, _mode, value) =>
          withSpectralDispersion(controls, "base", value)
      ),
      range(
        "dispersion-strength",
        "Dispersion B",
        PRISM_SPECTRAL_DISPERSION_RANGES.strength,
        (controls) =>
          (
            controls.spectralDispersion ??
            PRISM_DISPERSION_PRESETS[controls.dispersion]
          ).strength,
        (controls, _mode, value) =>
          withSpectralDispersion(controls, "strength", value)
      ),
    ],
  },
];

const LIGHT_APPEARANCE_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Light appearance",
    controls: [
      range(
        "beam-opacity",
        "Beam opacity",
        PRISM_LIGHT_FADE_RANGES.beamOpacity,
        (controls) => controls.lightFade.beamOpacity,
        (controls, _mode, value) =>
          withLightFade(controls, "beamOpacity", value)
      ),
      range(
        "edge-falloff",
        "Edge falloff",
        PRISM_LIGHT_FADE_RANGES.edgeFalloff,
        (controls) => controls.lightFade.edgeFalloff,
        (controls, _mode, value) =>
          withLightFade(controls, "edgeFalloff", value)
      ),
      range(
        "rainbow-falloff-rate",
        "Rainbow rate",
        PRISM_LIGHT_FADE_RANGES.rainbowFalloffRate,
        (controls) => controls.lightFade.rainbowFalloffRate,
        (controls, _mode, value) =>
          withLightFade(controls, "rainbowFalloffRate", value)
      ),
      range(
        "rainbow-falloff-power",
        "Rainbow power",
        PRISM_LIGHT_FADE_RANGES.rainbowFalloffPower,
        (controls) => controls.lightFade.rainbowFalloffPower,
        (controls, _mode, value) =>
          withLightFade(controls, "rainbowFalloffPower", value)
      ),
    ],
  },
];

const WALL_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Surface",
    controls: [
      {
        id: "wall-color",
        label: "Wall color",
        kind: "color",
        read: (controls) => controls.wallColor,
        write: (controls, _mode, value) => withWallColor(controls, value),
      },
    ],
  },
];

const NORMAL_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Surface relief",
    controls: [
      range(
        "normal-strength",
        "Normal strength",
        PRISM_LIGHT_MODE_RANGES.wall.normalStrength,
        (controls) => controls.lightMode.wall.normalStrength,
        (controls, _mode, value) =>
          withLightWall(controls, "normalStrength", value)
      ),
    ],
  },
];

const GLOBAL_LIGHT_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Lightmap transfer",
    preview: "shadowCurve",
    controls: [
      range(
        "lightmap-gamma",
        "Lightmap gamma",
        PRISM_LIGHT_MODE_RANGES.wall.lightmapGamma,
        (controls) => controls.lightMode.wall.lightmapGamma,
        (controls, _mode, value) =>
          withLightWall(controls, "lightmapGamma", value)
      ),
      range(
        "shadow-contrast",
        "Contrast",
        PRISM_LIGHT_MODE_RANGES.wall.shadowContrast,
        (controls) => controls.lightMode.wall.shadowContrast,
        (controls, _mode, value) =>
          withLightWall(controls, "shadowContrast", value)
      ),
      range(
        "shadow-pivot",
        "Pivot",
        PRISM_LIGHT_MODE_RANGES.wall.shadowPivot,
        (controls) => controls.lightMode.wall.shadowPivot,
        (controls, _mode, value) =>
          withLightWall(controls, "shadowPivot", value)
      ),
    ],
  },
];

const WALL_COMPOSITION_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Light balance",
    controls: [
      range(
        "shadow-floor",
        "Shadow floor",
        PRISM_LIGHT_MODE_RANGES.wall.shadowFloor,
        (controls) => controls.lightMode.wall.shadowFloor,
        (controls, _mode, value) =>
          withLightWall(controls, "shadowFloor", value)
      ),
      range(
        "highlight-exposure",
        "Highlight exposure",
        PRISM_LIGHT_MODE_RANGES.wall.highlightExposure,
        (controls) => controls.lightMode.wall.highlightExposure,
        (controls, _mode, value) =>
          withLightWall(controls, "highlightExposure", value)
      ),
      range(
        "ambient-fill",
        "Ambient fill",
        PRISM_LIGHT_MODE_RANGES.wall.ambientFill,
        (controls) => controls.lightMode.wall.ambientFill,
        (controls, _mode, value) =>
          withLightWall(controls, "ambientFill", value)
      ),
    ],
  },
];

const CAUSTIC_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Caustic compositing",
    controls: [
      range(
        "caustic-strength",
        "Strength",
        PRISM_LIGHT_MODE_RANGES.caustic.strength,
        (controls) => controls.lightMode.caustic.strength,
        (controls, _mode, value) =>
          withLightCaustic(controls, "strength", value)
      ),
      range(
        "caustic-coverage",
        "Coverage",
        PRISM_LIGHT_MODE_RANGES.caustic.coverage,
        (controls) => controls.lightMode.caustic.coverage,
        (controls, _mode, value) =>
          withLightCaustic(controls, "coverage", value)
      ),
      range(
        "caustic-normal-influence",
        "Normal influence",
        PRISM_LIGHT_MODE_RANGES.caustic.normalInfluence,
        (controls) => controls.lightMode.caustic.normalInfluence,
        (controls, _mode, value) =>
          withLightCaustic(controls, "normalInfluence", value)
      ),
      range(
        "caustic-normal-elevation",
        "Light elevation",
        PRISM_LIGHT_MODE_RANGES.caustic.normalElevation,
        (controls) => controls.lightMode.caustic.normalElevation,
        (controls, _mode, value) =>
          withLightCaustic(controls, "normalElevation", value)
      ),
    ],
  },
];

const OUTPUT_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Tone mapping",
    controls: [
      {
        id: "tone-mapping",
        label: "Tone mapper",
        kind: "select",
        options: PRISM_LIGHT_TONE_MAPPING_ORDER.map((value) => ({
          value,
          label: PRISM_LIGHT_TONE_MAPPING_LABELS[value],
        })),
        read: (controls) => controls.lightMode.output.toneMapping,
        write: (controls, _mode, value) =>
          withLightOutput(controls, "toneMapping", value as LightToneMapping),
      },
      range(
        "scene-exposure",
        "Scene exposure",
        PRISM_LIGHT_MODE_RANGES.output.exposure,
        (controls) => controls.lightMode.output.exposure,
        (controls, _mode, value) => withLightOutput(controls, "exposure", value)
      ),
    ],
  },
];

const TRANSMISSION_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Transmission",
    themeScoped: true,
    controls: [
      range(
        "glass-ior",
        "Surface IOR",
        PRISM_GLASS_RANGES.ior,
        (controls, mode) => controls.glass.transmission[mode].ior,
        (controls, mode, value) =>
          withTransmission(controls, mode, { ior: value })
      ),
      ...(["R", "G", "B"] as const).map((channel, index) =>
        range(
          `absorption-${channel.toLowerCase()}`,
          `Absorption ${channel}`,
          PRISM_GLASS_RANGES.absorption,
          (controls, mode) =>
            controls.glass.transmission[mode].absorption[index]!,
          (controls, mode, value) =>
            withAbsorption(controls, mode, index as 0 | 1 | 2, value)
        )
      ),
    ],
  },
];

const REFLECTION_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Environment reflection",
    themeScoped: true,
    controls: [
      range(
        "reflection-strength",
        "Reflection strength",
        PRISM_GLASS_RANGES.reflectionStrength,
        (controls, mode) => controls.glass.reflection[mode].reflectionStrength,
        (controls, mode, value) =>
          withReflection(controls, mode, "reflectionStrength", value)
      ),
      range(
        "environment-exposure",
        "Environment exposure",
        PRISM_GLASS_RANGES.environmentExposure,
        (controls, mode) => controls.glass.reflection[mode].environmentExposure,
        (controls, mode, value) =>
          withReflection(controls, mode, "environmentExposure", value)
      ),
    ],
  },
];

const BLOOM_CONTROLS: readonly DebugControlGroup[] = [
  {
    label: "Dark postprocess",
    controls: [
      range(
        "bloom-threshold",
        "Threshold",
        PRISM_POSTPROCESS_RANGES.bloomThreshold,
        (controls) => controls.postprocess.bloomThreshold,
        (controls, _mode, value) =>
          withPostprocess(controls, "bloomThreshold", value)
      ),
      range(
        "bloom-radius",
        "Radius",
        PRISM_POSTPROCESS_RANGES.bloomRadius,
        (controls) => controls.postprocess.bloomRadius,
        (controls, _mode, value) =>
          withPostprocess(controls, "bloomRadius", value)
      ),
      range(
        "bloom-strength",
        "Strength",
        PRISM_POSTPROCESS_RANGES.bloomStrength,
        (controls) => controls.postprocess.bloomStrength,
        (controls, _mode, value) =>
          withPostprocess(controls, "bloomStrength", value)
      ),
    ],
  },
];

const LOW_QUALITY_BLOOM_CONTROLS: readonly DebugControlGroup[] =
  BLOOM_CONTROLS.map((group) => ({
    ...group,
    controls: group.controls.filter(({ id }) => id !== "bloom-strength"),
  }));

export function controlGroupsForSource(
  sourceId: string,
  mode: PrismTheme,
  quality: PrismPipelineQuality = "high"
): readonly DebugControlGroup[] {
  switch (sourceId) {
    case "scene-hdr":
    case "dark-scene-hdr":
      return SCENE_CONTROLS;
    case "projected-caustic":
      return [
        ...BEAM_CONTROLS,
        ...SPECTRAL_CONTROLS,
        ...LIGHT_APPEARANCE_CONTROLS,
        ...CAUSTIC_CONTROLS,
      ];
    case "dark-external-light":
      return [
        ...BEAM_CONTROLS,
        ...SPECTRAL_CONTROLS,
        ...LIGHT_APPEARANCE_CONTROLS,
      ];
    case "wall-material":
    case "dark-wall":
      return WALL_CONTROLS;
    case "wall-normal":
      return NORMAL_CONTROLS;
    case "global-shadow":
      return GLOBAL_LIGHT_CONTROLS;
    case "composed-wall":
      return WALL_COMPOSITION_CONTROLS;
    case "front-glass":
    case "dark-front-glass":
      return [...TRANSMISSION_CONTROLS, ...REFLECTION_CONTROLS];
    case "dark-bloom-composite":
      return mode !== "dark"
        ? []
        : quality === "low"
        ? LOW_QUALITY_BLOOM_CONTROLS
        : BLOOM_CONTROLS;
    case "final-output":
      return OUTPUT_CONTROLS;
    default:
      return [];
  }
}

export function clampDebugRangeValue(
  control: DebugRangeControl,
  value: number
): number {
  return Math.min(control.max, Math.max(control.min, value));
}

function matchingDispersionPreset(controls: PrismControls): string {
  const value =
    controls.spectralDispersion ??
    PRISM_DISPERSION_PRESETS[controls.dispersion];
  return (
    PRISM_DISPERSION_ORDER.find((preset) => {
      const candidate = PRISM_DISPERSION_PRESETS[preset];
      return (
        Math.abs(candidate.base - value.base) < 1e-8 &&
        Math.abs(candidate.strength - value.strength) < 1e-8
      );
    }) ?? "custom"
  );
}
