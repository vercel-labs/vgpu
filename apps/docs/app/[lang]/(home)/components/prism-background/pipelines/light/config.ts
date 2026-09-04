/** Centralized look-development values measured against the generated reference. */
export const LIGHT_PIPELINE_TUNING = Object.freeze({
  wall: {
    materialScale: 2.4,
    normalStrength: 0.22,
    microNormalFrequency: 7,
    microNormalStrength: 1.05,
    ambient: 0.5,
    prismShadowStrength: 1,
    prismAoStrength: 1,
    groundingScale: 2,
  },
  caustic: {
    farDesaturation: 0.04,
    farBrightness: 0.02,
    travelScale: 1,
    falloffRateScale: 0.12,
    falloffPowerScale: 0.5,
  },
});
