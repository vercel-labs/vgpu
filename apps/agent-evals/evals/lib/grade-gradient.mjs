/**
 * Gradient grading, kept as a plain module so the eval and any offline probe
 * grade with the SAME code. A probe that copies this logic is a probe that
 * silently stops describing the eval the first time either side is edited.
 *
 * Layer note: this is pure pixel arithmetic. No eve, no filesystem, no network,
 * so it can be exercised against synthetic PNGs without spending a model call.
 */

/** @typedef {{ width: number, height: number, data: Uint8Array }} PngLike */

/**
 * Per-channel slack for colour comparisons.
 *
 * A gradient is interpolated and then quantised to 8 bits, and rasterisers
 * disagree in the last bit or two.
 */
export const TOL = 2;

/** Sample stride along a probed row. Every pixel is unnecessary and noisy. */
export const STRIDE = 8;

/**
 * How mixed the midpoint must be, per channel.
 *
 * Deliberately a wide window rather than "127 +/- a little". The midpoint of a
 * visually correct red-to-blue ramp is ~127 when the interpolation happens in
 * sRGB space and ~186 when it happens in linear light and is encoded on write:
 * the same correct image, two very different numbers. Pinning the midpoint near
 * 127 would fail a gamma-correct renderer for being gamma-correct.
 *
 * This window answers the opposite, cruder question: is the midpoint a BLEND at
 * all? A hard step (an endpoint colour, 0 or 255) and a trip through black
 * (both channels near 0) are the two ways to satisfy monotonicity without being
 * a gradient, and both land outside it.
 */
export const MIX_MIN = 32;
export const MIX_MAX = 223;

/**
 * Rows to probe, as fractions of the height.
 *
 * More than one on purpose: an image can carry a perfect gradient along the
 * middle row and arbitrary noise everywhere else, and a single-row check calls
 * that a pass.
 */
export const ROW_FRACTIONS = [0.25, 0.5, 0.75];

/**
 * @param {PngLike} png
 * @returns {[number, number, number, number]}
 */
export function pixel(png, x, y) {
  const i = (png.width * y + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

/**
 * Largest per-channel deviation of a whole column from an expected colour.
 *
 * @param {PngLike} png
 * @param {number} x
 * @param {readonly number[]} expected
 */
export function columnDeviation(png, x, expected) {
  let worst = 0;
  for (let y = 0; y < png.height; y += 1) {
    const px = pixel(png, x, y);
    for (let c = 0; c < 4; c += 1) worst = Math.max(worst, Math.abs(px[c] - expected[c]));
  }
  return worst;
}

/**
 * Grade a red-to-blue horizontal gradient.
 *
 * @param {PngLike} png
 * @param {number} size expected width and height
 */
export function gradeGradient(png, size) {
  const sizeOk = png.width === size && png.height === size;
  const leftOff = columnDeviation(png, 0, [255, 0, 0, 255]);
  const rightOff = columnDeviation(png, png.width - 1, [0, 0, 255, 255]);

  const xs = [];
  for (let x = 0; x < png.width; x += STRIDE) xs.push(x);
  if (xs[xs.length - 1] !== png.width - 1) xs.push(png.width - 1);
  const midX = Math.floor(png.width / 2);

  let redRises = 0;
  let blueFalls = 0;
  let greenOff = 0;
  let midOff = false;
  /** @type {{ y: number, mid: number[], R: number[], B: number[] }[]} */
  const rows = [];

  for (const fraction of ROW_FRACTIONS) {
    const y = Math.min(png.height - 1, Math.floor(png.height * fraction));
    const samples = xs.map((x) => pixel(png, x, y));
    for (let i = 0; i < samples.length; i += 1) {
      greenOff = Math.max(greenOff, Math.abs(samples[i][1]));
      if (i === 0) continue;
      // Tolerated wobble, not a trend: consecutive samples may reverse by up to
      // TOL (dither, rounding) without counting against monotonicity.
      if (samples[i][0] > samples[i - 1][0] + TOL) redRises += 1;
      if (samples[i][2] < samples[i - 1][2] - TOL) blueFalls += 1;
    }
    const [midR, , midB] = pixel(png, midX, y);
    if (midR < MIX_MIN || midR > MIX_MAX || midB < MIX_MIN || midB > MIX_MAX) midOff = true;
    rows.push({ y, mid: [midR, midB], R: samples.map((s) => s[0]), B: samples.map((s) => s[2]) });
  }

  return {
    sizeOk,
    leftOff,
    rightOff,
    /** Red never climbs and blue never drops across the probed rows, and green stays out of it. */
    monotonic: redRises === 0 && blueFalls === 0 && greenOff <= TOL,
    /** The middle column is a genuine red/blue blend, not an endpoint and not black. */
    midpointMixed: !midOff,
    redRises,
    blueFalls,
    greenOff,
    rows,
    get pass() {
      return (
        this.sizeOk &&
        this.leftOff <= TOL &&
        this.rightOff <= TOL &&
        this.monotonic &&
        this.midpointMixed
      );
    },
  };
}
