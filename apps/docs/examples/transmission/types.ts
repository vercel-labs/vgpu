/** Refraction quality: one interface (front face only) or both faces of the cube. */
export type RefractionMode = 'simple' | 'double';

export interface TransmissionControls {
  /** Index of refraction: 1 is air-like, 1.5 is typical soda-lime glass. */
  readonly ior: number;
  /** Frosting: 0 is polished glass, 1 walks up the blurred scene pyramid. */
  readonly roughness: number;
  /** Splits the index of refraction per channel, so edges fringe like real glass. */
  readonly dispersion: boolean;
  readonly refraction: RefractionMode;
}

export const DEFAULT_TRANSMISSION_CONTROLS: TransmissionControls = {
  ior: 1.5,
  roughness: 0.06,
  dispersion: true,
  refraction: 'double',
};
