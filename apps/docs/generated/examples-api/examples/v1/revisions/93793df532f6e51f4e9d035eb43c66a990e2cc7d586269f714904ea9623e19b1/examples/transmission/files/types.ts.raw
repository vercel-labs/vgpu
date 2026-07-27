/** Refraction quality: one interface (front face only) or both faces of the cube. */
export type RefractionMode = 'simple' | 'double';

export interface TransmissionControls {
  /** Frosting: 0 is polished glass, 1 walks up the blurred scene pyramid. */
  readonly roughness: number;
  /** Splits the index of refraction per channel, so edges fringe like real glass. */
  readonly dispersion: boolean;
  readonly refraction: RefractionMode;
}

export const DEFAULT_TRANSMISSION_CONTROLS: TransmissionControls = {
  roughness: 0.06,
  dispersion: true,
  refraction: 'double',
};
