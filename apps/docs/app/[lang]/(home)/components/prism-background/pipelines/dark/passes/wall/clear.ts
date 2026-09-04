import type { PrismView } from "../../../../types";

export type DarkWallClear = readonly [number, number, number, 1];

const BLACK_CLEAR: DarkWallClear = [0, 0, 0, 1];
const HEX_COLOR = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;

/** Matches the wall shader's sRGB transfer before additive dark-mode draws. */
export function darkWallClear(
  wallColor: string,
  view: PrismView
): DarkWallClear {
  if (view === "caustic") return BLACK_CLEAR;
  const channels = wallColor.match(HEX_COLOR);
  if (!channels) return BLACK_CLEAR;
  return [
    srgbToLinear(Number.parseInt(channels[1]!, 16) / 255),
    srgbToLinear(Number.parseInt(channels[2]!, 16) / 255),
    srgbToLinear(Number.parseInt(channels[3]!, 16) / 255),
    1,
  ];
}

export function srgbToLinear(value: number): number {
  if (value <= 0.04045) return value / 12.92;
  return ((value + 0.055) / 1.055) ** 2.4;
}
