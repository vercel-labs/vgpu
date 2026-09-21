import { wavelengthToBeamRgb } from "../../../scene/optics";
import { clamp01, fbm, smoothstep, writePixel } from "./math";
import type { GeneratedLightAsset } from "./types";

export function generateCausticProfile(
  size: readonly [number, number]
): GeneratedLightAsset {
  const [width, height] = size;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const wavelength = 700 - (y / Math.max(1, height - 1)) * 300;
    const spectral = wavelengthToBeamRgb(wavelength);
    for (let x = 0; x < width; x++) {
      const travel = x / Math.max(1, width - 1);
      const coarse = fbm(travel * 18, wavelength * 0.018, 4);
      const filament = 0.5 + 0.5 * Math.sin(travel * 104 + wavelength * 0.071);
      const focus = 0.72 + coarse * 0.24 + filament * 0.04;
      const tail = 1 - smoothstep(0.58, 1.08, travel) * 0.44;
      const farNeutral = smoothstep(0.2, 0.88, travel) * 0.36;
      const peak = Math.max(spectral[0], spectral[1], spectral[2], 1e-5);
      const hue = spectral.map((channel) => channel / peak) as [
        number,
        number,
        number
      ];
      const rgb = hue.map((channel) =>
        clamp01((channel * (1 - farNeutral) + farNeutral) * focus * tail)
      ) as [number, number, number];
      writePixel(pixels, (y * width + x) * 4, [...rgb, focus * tail]);
    }
  }
  return { width, height, pixels };
}
