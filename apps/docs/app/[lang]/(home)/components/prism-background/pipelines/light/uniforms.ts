import { LIGHT_PIPELINE_TUNING } from "./config";
import { runtimeWallExtent } from "../../runtime/uniforms";
import type { PrismRuntime } from "../../runtime/types";
import {
  PRISM_CENTROID,
  PRISM_LIGHT_TONE_MAPPING_CODES,
  PRISM_SIDE,
} from "../../types";
import { presentationRevealUniforms } from "../shared/presentation/index";

export function lightWallUniforms(
  runtime: PrismRuntime
): Record<string, unknown> {
  const tuning = LIGHT_PIPELINE_TUNING.wall;
  const controls = runtime.controls.lightMode.wall;
  const wallColor = runtime.controls.wallColor.match(
    /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i
  );
  return {
    viewProjection: runtime.view.viewProjection,
    wallHalfExtent: runtimeWallExtent(runtime),
    wallColor: wallColor
      ? wallColor.slice(1).map((channel) => Number.parseInt(channel, 16) / 255)
      : [0.87, 0.87, 0.87],
    prismCenter: PRISM_CENTROID,
    // A more grazing upper-left key makes the plaster normals readable while
    // the baked HDR blobs remain responsible for the white illumination peaks.
    lightDirection: [-0.48, 0.56, 0.68],
    materialWorldScale: PRISM_SIDE * tuning.materialScale,
    normalStrength: tuning.normalStrength * controls.normalStrength,
    microNormalFrequency: tuning.microNormalFrequency,
    microNormalStrength: tuning.microNormalStrength * controls.normalStrength,
    ambient: tuning.ambient,
    ambientLightStrength: controls.ambientFill,
    globalLightTransfer: controls.lightmapGamma,
    shadowContrast: controls.shadowContrast,
    shadowPivot: controls.shadowPivot,
    shadowFloor: controls.shadowFloor,
    highlightExposure: controls.highlightExposure,
    // The broad cast shadow is a geometry draw. Preserve only the separately
    // baked contact/AO channel in the wall material composition.
    prismShadowStrength: 0,
    prismAoStrength: tuning.prismAoStrength,
    groundingScale: PRISM_SIDE * tuning.groundingScale,
  };
}

export function lightCausticUniforms(
  runtime: PrismRuntime
): Record<string, unknown> {
  const tuning = LIGHT_PIPELINE_TUNING.caustic;
  const controls = runtime.controls.lightMode.caustic;
  const wall = LIGHT_PIPELINE_TUNING.wall;
  const wallControls = runtime.controls.lightMode.wall;
  return {
    strength: controls.strength,
    coverage: controls.coverage,
    farDesaturation: tuning.farDesaturation,
    farBrightness: tuning.farBrightness,
    // Light-mesh travel is already normalized from the prism to the wall edge.
    travelScale: tuning.travelScale,
    falloffRateScale: tuning.falloffRateScale,
    falloffPowerScale: tuning.falloffPowerScale,
    materialWorldScale: PRISM_SIDE * wall.materialScale,
    normalStrength: wall.normalStrength * wallControls.normalStrength,
    microNormalFrequency: wall.microNormalFrequency,
    microNormalStrength:
      wall.microNormalStrength * wallControls.normalStrength,
    normalInfluence: controls.normalInfluence,
    normalElevation: controls.normalElevation,
  };
}

export function lightPresentUniforms(
  runtime: PrismRuntime,
  revealProgress = 1
): Record<string, unknown> {
  const output = runtime.controls.lightMode.output;
  return {
    ...presentationRevealUniforms("light", revealProgress),
    exposure: output.exposure,
    toneMapping: PRISM_LIGHT_TONE_MAPPING_CODES[output.toneMapping],
  };
}
