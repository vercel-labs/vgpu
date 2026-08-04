/**
 * Deterministic fixtures for the MNIST example.
 *
 * The seeded digit is authored here as a polyline and rasterized in pure
 * TypeScript, so the browser, unit tests and the Node thumbnail all derive the
 * identical 28x28 input without a Canvas2D surface. The golden logits were
 * captured from the committed model for exactly that input, which lets the
 * thumbnail render real bars with no ORT, network or browser involved.
 */
import { hashPixels, preprocessDigit } from './preprocess';

/** Same-origin model asset; see public/models/mnist/provenance.md. */
export const MODEL_URL = '/models/mnist/mnist-12.onnx';
export const MODEL_SHA256 = '5c688690f8bacf667d4c2074af5ad0646ca328d7ab03eccf944a65b320171bdd';
export const MODEL_BYTES = 26_143;
/** Graph I/O names of mnist-12, used when a session omits them. */
export const MODEL_INPUT_NAME = 'Input3';
export const MODEL_OUTPUT_NAME = 'Plus214_Output_0';
/** Ten pre-softmax logits: 10 * 4 bytes. */
export const LOGIT_COUNT = 10;
export const LOGIT_BYTES = LOGIT_COUNT * 4;

/** The drawing surface is a fixed square in logical pixels. */
export const FIXTURE_SURFACE = 280;
/** Brush radius in surface pixels; the interactive canvas uses the same value. */
export const STROKE_RADIUS = 11;
/** What the seeded stroke is meant to be. */
export const FIXTURE_LABEL = 7;

export type Point = readonly [number, number];

/** A hand-authored '7' in 280x280 surface coordinates. */
export const FIXTURE_STROKES: readonly (readonly Point[])[] = [
  [
    [74, 68],
    [208, 62],
    [168, 132],
    [120, 232],
  ],
];

/**
 * Antialiased capsule rasterizer: coverage is the signed distance to the
 * polyline clamped to one pixel of feather, which matches a round brush.
 */
export function rasterizeStrokes(
  strokes: readonly (readonly Point[])[] = FIXTURE_STROKES,
  size = FIXTURE_SURFACE,
  radius = STROKE_RADIUS,
): Float32Array {
  const field = new Float32Array(size * size);
  for (const stroke of strokes) {
    for (let i = 0; i + 1 < stroke.length; i++) {
      const [ax, ay] = stroke[i]!;
      const [bx, by] = stroke[i + 1]!;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy || 1;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 1));
      const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + radius + 1));
      const minY = Math.max(0, Math.floor(Math.min(ay, by) - radius - 1));
      const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by) + radius + 1));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5 - ax;
          const py = y + 0.5 - ay;
          const t = Math.min(1, Math.max(0, (px * dx + py * dy) / lengthSq));
          const distance = Math.hypot(px - t * dx, py - t * dy);
          const coverage = Math.min(1, Math.max(0, radius + 0.5 - distance));
          const index = y * size + x;
          if (coverage > field[index]!) field[index] = coverage;
        }
      }
    }
  }
  return field;
}

/** The seeded 28x28 model input, normalized exactly like a user drawing. */
export function createFixtureDigit(): Float32Array {
  const field = rasterizeStrokes();
  const pixels = preprocessDigit(field, FIXTURE_SURFACE, FIXTURE_SURFACE);
  if (!pixels) throw new Error('The seeded fixture stroke produced no ink.');
  return pixels;
}

/** Pins the fixture: a change to the strokes or preprocessing must be deliberate. */
export const FIXTURE_PIXEL_HASH = '12851381';

/**
 * Logits produced by the committed mnist-12.onnx for `createFixtureDigit()`,
 * captured with onnxruntime 1.28 on the CPU execution provider. Pre-softmax, in
 * class order 0..9; index 7 dominates, which is the fixture's label.
 */
export const GOLDEN_LOGITS = new Float32Array([
  -7.533131, 7.212919, 5.826909, 6.00873, -12.431555, -8.755082, -21.573675, 29.645443, -8.709205,
  1.797541,
]);

/** Convenience for tests and the thumbnail. */
export function fixtureHash(): string {
  return hashPixels(createFixtureDigit());
}
