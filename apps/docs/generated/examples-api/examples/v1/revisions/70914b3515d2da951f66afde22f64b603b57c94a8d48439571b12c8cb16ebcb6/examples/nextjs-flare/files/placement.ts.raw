import type { Point } from './animation';
import { flarePlacement, logoPixelSize, type FlarePlacement } from './settings';

export const LOGO_CENTER: Point = [0.5, 0.5];

const GLYPH_CENTER_IN_BOX: Point = [(48 + 466 / 2) / 514, (88 + 536 / 2) / 624];

export function centeredPlacement(
  width: number,
  height: number,
  reference: number
): FlarePlacement {
  const [logoWidth, logoHeight] = logoPixelSize(reference, 1);
  return flarePlacement(width, height, reference, [
    0.5 - (GLYPH_CENTER_IN_BOX[0] - 0.5) * (logoWidth / width),
    0.5 - (GLYPH_CENTER_IN_BOX[1] - 0.5) * (logoHeight / height),
  ]);
}
