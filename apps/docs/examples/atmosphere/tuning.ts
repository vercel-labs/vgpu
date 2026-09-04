export type Tonemap = 'agx' | 'aces' | 'neutral' | 'none';
export const TONEMAPS: readonly Tonemap[] = ['agx', 'aces', 'neutral', 'none'];

/** Everything the viewer can change: sun placement, camera placement, and display mapping. */
export interface AtmosphereState {
  /** Degrees above the horizon; negative values are twilight. */
  sunElevation: number;
  /** Degrees, 0 = toward +Z (straight ahead at yaw 0). */
  sunAzimuth: number;
  /** Camera altitude above sea level in kilometres. */
  altitudeKm: number;
  /** Camera yaw in degrees, 0 = +Z. */
  yaw: number;
  /** Camera pitch in degrees, positive looks up. */
  pitch: number;
  /** Exposure in stops: display = scene * 2^exposureEv. */
  exposureEv: number;
  /** Aerosol density multiplier: 1 is the pristine Bruneton atmosphere, 3-6 is a hazy summer day. */
  haze: number;
  /** Global cloud coverage in [0, 1]; 0 disables the cloud pass. */
  cloudCoverage: number;
  /** Edge detail strength: 0 is smooth billows, 1 is the default erosion and curl, 1.5 is very wispy. */
  cloudDetail: number;
  /** Cloud type bias: -1 pushes everything toward flat stratus, +1 toward tall cumulus. */
  cloudType: number;
  /** Weather seed: any value picks a different patch of the tileable weather map. */
  cloudSeed: number;
  /** Whether the clouds shade the terrain and the air below them. */
  cloudShadows: boolean;
  /** Scene time in seconds; drives the wind that advects the clouds. */
  time: number;
  tonemap: Tonemap;
}

/** Physical atmosphere (Bruneton / Hillaire coefficients, kilometre units). */
export const ATMOSPHERE_PHYSICS = {
  groundRadius: 6360,
  atmosphereRadius: 6460,
  rayleighScattering: [0.005802, 0.013558, 0.0331] as const,
  rayleighScaleHeight: 8,
  mieScattering: [0.003996, 0.003996, 0.003996] as const,
  mieAbsorption: [0.0044, 0.0044, 0.0044] as const,
  mieScaleHeight: 1.2,
  mieG: 0.8,
  ozoneAbsorption: [0.00065, 0.001881, 0.000085] as const,
  ozoneCenter: 25,
  ozoneWidth: 15,
  groundAlbedo: [0.3, 0.3, 0.3] as const,
  /** Unit sun; exposure carries the absolute scale. */
  sunIlluminance: [1, 1, 1] as const,
  /** 0.2665 degrees in radians. */
  sunAngularRadius: 0.004651,
} as const;

/** LUT sizes; keep in sync with the constants in atmosphere-common.wgsl. */
export const LUT_SIZES = {
  transmittance: [256, 64] as const,
  multiScatter: 32,
  skyView: [192, 108] as const,
  aerial: [96, 64, 32] as const,
} as const;

export const CAMERA_TUNING = { fovDegrees: 60, maxAltitudeKm: 80 } as const;

/** Cloud layer (km) and noise scales; the cloud pass renders at 1/renderScale of the output and present.wgsl upsamples it depth-aware. */
export const CLOUD_TUNING = {
  bottom: 1.6,
  top: 4.2,
  density: 1.0,
  shapeScale: 7.0,
  detailScale: 1.1,
  weatherScale: 80,
  detailStrength: 1.0,
  /** Curl distortion of the detail lookup, km. */
  curlStrength: 0.25,
  /** Erosion detail fades with distance in rings of this length (km): fine detail to 1x, curl to 2x, coarse to 4x. */
  detailLodDistance: 32,
  windSpeed: 0.03,
  renderScale: 2,
  noise: { shape: 128, detail: 32, weather: 1024 },
} as const;

export const PRESETS = {
  'golden-hour': { sunElevation: 4, sunAzimuth: 58, altitudeKm: 0.08, yaw: 40, pitch: 9, exposureEv: 5, haze: 2, cloudCoverage: 0.65, cloudDetail: 1, cloudType: 0, cloudSeed: 0, cloudShadows: true, time: 0, tonemap: 'agx' },
  noon: { sunElevation: 62, sunAzimuth: 40, altitudeKm: 0.08, yaw: 0, pitch: 6, exposureEv: 3, haze: 2, cloudCoverage: 0.45, cloudDetail: 1, cloudType: 0, cloudSeed: 0, cloudShadows: true, time: 0, tonemap: 'agx' },
  twilight: { sunElevation: -4, sunAzimuth: 10, altitudeKm: 0.08, yaw: 0, pitch: 6, exposureEv: 8, haze: 2, cloudCoverage: 0.35, cloudDetail: 1, cloudType: 0, cloudSeed: 0, cloudShadows: true, time: 0, tonemap: 'agx' },
  'high-altitude': { sunElevation: 18, sunAzimuth: 35, altitudeKm: 10, yaw: 0, pitch: -4, exposureEv: 3.5, haze: 2, cloudCoverage: 0.5, cloudDetail: 1, cloudType: 0, cloudSeed: 0, cloudShadows: true, time: 0, tonemap: 'agx' },
  stratosphere: { sunElevation: 25, sunAzimuth: 60, altitudeKm: 35, yaw: 0, pitch: -8, exposureEv: 3.5, haze: 2, cloudCoverage: 0.5, cloudDetail: 1, cloudType: 0, cloudSeed: 0, cloudShadows: true, time: 0, tonemap: 'agx' },
} as const satisfies Record<string, AtmosphereState>;

export type PresetName = keyof typeof PRESETS;
export const DEFAULT_PRESET: PresetName = 'golden-hour';
