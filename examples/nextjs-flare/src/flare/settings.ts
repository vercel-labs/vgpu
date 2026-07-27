import { DEFAULT_BLUR_SIGMA } from "./blur-kernel.ts";

export type FlarePlacement = {
  logoCenter: readonly [number, number];
  logoScale: readonly [number, number];
  canvasToLogo: readonly [number, number];
};

export type FlareSettings = {
  intensity: { beam: number; rim: number };
  blurSigma: number;
  flareColor: string;
  extension: number;
  filmGrain: number;
  smoothness: number;
  logoOpacity: number;
  spotReach: number;
  spotFocus: number;
  spotStrokePx: number;
  scatter: boolean;
  rimFill: boolean;
  verticalEdgeFade: number;
};

// The vercel.com /frameworks/nextjs dark-mode hero values, verbatim.
export const DEFAULT_FLARE_SETTINGS: Readonly<FlareSettings> = Object.freeze({
  intensity: { beam: 0.8, rim: 1 },
  blurSigma: DEFAULT_BLUR_SIGMA,
  flareColor: "#b3bfff",
  extension: 0.6,
  filmGrain: 0.03,
  smoothness: 1,
  logoOpacity: 1,
  spotReach: 0.5,
  spotFocus: 0.08,
  spotStrokePx: 0.9,
  scatter: true,
  rimFill: true,
  verticalEdgeFade: 0.1,
});

export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

export function flarePlacement(
  canvasWidth: number,
  canvasHeight: number,
  trackerSize: number,
  logoCenter: readonly [number, number],
): FlarePlacement {
  const [logoWidth, logoHeight] = logoPixelSize(trackerSize, 1);
  return {
    logoCenter,
    logoScale: [logoWidth / canvasWidth, logoHeight / canvasHeight],
    canvasToLogo: [canvasWidth / trackerSize, canvasHeight / trackerSize],
  };
}

// Fraction of the reference size the glyph occupies. The rendered SVG box is
// the geometry source of truth: referenceSize = svgRect.height / LOGO_HEIGHT_RATIO,
// which keeps every bake-relative ratio (overlay box, raster size, logo-local
// units) valid no matter how the layout scales the SVG.
export const LOGO_HEIGHT_RATIO = 0.62;

export function logoPixelSize(
  size: number,
  logoSize: number,
): [number, number] {
  // Padded logo box (glyph 466x536 plus 48/88 top-left visual-centering
  // padding baked into the SVG viewBox); must match the SVG sources.
  const aspect = 514 / 624;
  const availableHeight = size * LOGO_HEIGHT_RATIO * logoSize;
  const availableWidth = size * LOGO_HEIGHT_RATIO * logoSize;
  const height = Math.min(availableHeight, availableWidth / aspect);
  return [
    Math.max(1, Math.round(height * aspect)),
    Math.max(1, Math.round(height)),
  ];
}
