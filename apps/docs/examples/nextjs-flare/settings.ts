import { DEFAULT_BLUR_SIGMA } from './blur-kernel';

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
  followSeconds: number;
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
  flareColor: '#b3bfff',
  extension: 0.6,
  filmGrain: 0.03,
  smoothness: 1,
  logoOpacity: 1,
  followSeconds: 0.3,
  spotReach: 0.5,
  spotFocus: 0.08,
  spotStrokePx: 0.9,
  scatter: true,
  rimFill: true,
  verticalEdgeFade: 0.1,
});

export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

const MAX_RENDER_WIDTH = 1920;

export function backingDimensions(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): readonly [number, number] {
  const pixelRatio = Math.min(
    Math.max(dpr, 1),
    1.75,
    MAX_RENDER_WIDTH / Math.max(cssWidth, 1),
  );
  return [
    Math.max(1, Math.floor(cssWidth * pixelRatio)),
    Math.max(1, Math.floor(cssHeight * pixelRatio)),
  ];
}

export function flarePlacement(
  canvasWidth: number,
  canvasHeight: number,
  referenceSize: number,
  logoCenter: readonly [number, number],
): FlarePlacement {
  const [logoWidth, logoHeight] = logoPixelSize(referenceSize, 1);
  return {
    logoCenter,
    logoScale: [logoWidth / canvasWidth, logoHeight / canvasHeight],
    canvasToLogo: [canvasWidth / referenceSize, canvasHeight / referenceSize],
  };
}

// Fraction of the reference size the glyph occupies.
export const LOGO_HEIGHT_RATIO = 0.62;

export function logoPixelSize(size: number, logoSize: number): [number, number] {
  // Padded logo box (glyph 466x536 plus 48/88 top-left visual-centering
  // padding baked into the SVG viewBox); must match the SVG sources.
  const aspect = 514 / 624;
  const availableHeight = size * LOGO_HEIGHT_RATIO * logoSize;
  const availableWidth = size * LOGO_HEIGHT_RATIO * logoSize;
  const height = Math.min(availableHeight, availableWidth / aspect);
  return [Math.max(1, Math.round(height * aspect)), Math.max(1, Math.round(height))];
}
