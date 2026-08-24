/**
 * A deterministic stand-in for a decoded video frame.
 *
 * The headless thumbnail path has no video decoder and no network, and the browser
 * path has no picture at all until the first `requestVideoFrameCallback` fires.
 * Both upload this instead: colour bars with a grid and a dark band along the top
 * edge, which together prove the texture is sampled with the right orientation and
 * the right aspect handling without depending on a codec.
 */
export interface TestPattern {
  readonly width: number;
  readonly height: number;
  /** Tightly packed RGBA8, row-major, top row first. */
  readonly rgba: Uint8Array<ArrayBuffer>;
}

const BARS: readonly (readonly [number, number, number])[] = [
  [235, 235, 235],
  [235, 210, 60],
  [60, 210, 235],
  [60, 200, 90],
  [220, 80, 200],
  [220, 70, 60],
  [50, 70, 200],
  [24, 24, 28],
];

export function createTestPattern(width: number, height: number): TestPattern {
  const rgba = new Uint8Array(width * height * 4);
  const barWidth = width / BARS.length;
  // A dark band along the top eighth only. The bars are already near saturation,
  // so a *brighter* top band would simply clip and read as no marker at all; a
  // dark one is unambiguous, which is the whole point of having it — an upside
  // down or transposed sampling of this texture has to be visible at a glance.
  const bandHeight = Math.max(1, Math.round(height / 8));
  for (let y = 0; y < height; y += 1) {
    const inBand = y < bandHeight;
    for (let x = 0; x < width; x += 1) {
      const bar = BARS[Math.min(BARS.length - 1, Math.floor(x / barWidth))]!;
      const grid = x % Math.max(8, Math.round(width / 12)) === 0 || y % Math.max(8, Math.round(height / 8)) === 0;
      const gain = inBand ? 0.35 : 1;
      const offset = (y * width + x) * 4;
      rgba[offset] = clamp(bar[0] * gain + (grid ? 40 : 0));
      rgba[offset + 1] = clamp(bar[1] * gain + (grid ? 40 : 0));
      rgba[offset + 2] = clamp(bar[2] * gain + (grid ? 40 : 0));
      rgba[offset + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
