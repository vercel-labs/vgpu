/**
 * Canonical parameter table copied from front/fft-ocean-1 DEFAULT_SETTINGS,
 * settings constants, uniform-packing, and bloom-pass. Keep gallery-only deltas
 * (resolution selector, deterministic GPU noise and orbit input) out of this table.
 */
export const OCEAN_TUNING = {
  simulation: {
    oceanSize: 200,
    worldSize: 400,
    gravity: 9.81,
    timeScale: 0.6,
    spectrumTimeScale: 0.5,
    windSpeed: 12.9,
    windAngle: 4.83,
    amplitude: 1.3,
    choppiness: 1.51,
    displacementScale: 0.005,
    foamThreshold: 0,
    phillipsShortWaveRatio: 0.001,
    oppositeWindDamping: 0.07,
  },
  particles: {
    pointSize: 0.75,
    snap: 50,
    fadeNear: 60,
    fadeFar: 115,
    fadePower: 3.2,
    oceanColor: [0.003035269835488375, 0.003035269835488375, 0.003035269835488375, 0] as const,
    neonColor: [1, 1, 1, 0] as const,
    foamColor: [1, 1, 1, 0] as const,
  },
  camera: {
    eye: [0, 19.3, 60] as const,
    target: [0, 17.3, -40] as const,
    up: [0, 1, 0] as const,
    pitchDegrees: -38.9,
    fovDegrees: 60,
    near: 0.1,
    far: 2000,
  },
  bloom: {
    threshold: 0.55,
    smoothWidth: 0.01,
    strength: 0.08,
    radius: 0.46,
    levels: 5,
    kernelRadii: [6, 10, 14, 18, 22] as const,
    factors: [1, 0.8, 0.6, 0.4, 0.2] as const,
  },
  present: {
    exposure: 1,
    linearToSrgbExponent: 0.41666,
    clear: [0, 0, 0, 0] as const,
  },
} as const;

/** Matches front's `gaussianCoefficients`: sigma=radius/3, no normalization pass. */
export function gaussianCoefficients(kernelRadius: number): readonly number[] {
  return Array.from({ length: 24 }, (_, index) => index < kernelRadius
    ? (0.39894 * Math.exp((-0.5 * index * index) / ((kernelRadius / 3) ** 2))) / (kernelRadius / 3)
    : 0);
}
