/**
 * Pure CPU preprocessing from a drawing surface to the model's input tensor.
 *
 * mnist-12 expects `float32[1, 1, 28, 28]` with values in [0, 1], white strokes
 * on a black field, digit-centred the way the MNIST dataset is normalized:
 * crop to the ink, scale the long side into a 20x20 box, then place it in a
 * 28x28 field by centre of mass.
 *
 * 784 values per interaction are tiny, so this stays on the CPU where it is easy
 * to test. The zero-copy claim in this example applies to the model *output*.
 */

/** Side length of the model input. */
export const INPUT_SIZE = 28;
/** MNIST normalizes the glyph into a 20x20 box inside the 28x28 field. */
export const DIGIT_BOX = 20;
/** Values at or below this are treated as background when cropping. */
export const INK_THRESHOLD = 0.08;

export interface InkBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Converts RGBA canvas bytes to a single-channel foreground field in [0, 1].
 * The drawing surface paints opaque white ink on black, so luminance and alpha
 * agree; multiplying them tolerates both a cleared and a filled backdrop.
 */
export function foregroundFromRgba(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const expected = width * height * 4;
  if (data.length !== expected) {
    throw new Error(`Expected ${expected} RGBA bytes for ${width}x${height}, received ${data.length}.`);
  }
  const field = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const luma = (0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!) / 255;
    field[p] = luma * (data[i + 3]! / 255);
  }
  return field;
}

/** Bounding box of ink above the threshold, or `undefined` for an empty field. */
export function inkBounds(
  field: Float32Array,
  width: number,
  height: number,
  threshold = INK_THRESHOLD,
): InkBounds | undefined {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (field[y * width + x]! <= threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return undefined;
  return { minX, minY, maxX, maxY };
}

/** Box-filter average of `field` over the source rectangle. */
function sampleBox(
  field: Float32Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const startX = Math.max(0, Math.floor(x0));
  const startY = Math.max(0, Math.floor(y0));
  const endX = Math.min(width, Math.max(startX + 1, Math.ceil(x1)));
  const endY = Math.min(height, Math.max(startY + 1, Math.ceil(y1)));
  let sum = 0;
  let count = 0;
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      sum += field[y * width + x]!;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Normalizes a drawing into the model's 28x28 input.
 *
 * Returns `undefined` when the surface holds no ink, so callers can skip
 * inference instead of classifying an empty canvas.
 */
export function preprocessDigit(
  field: Float32Array,
  width: number,
  height: number,
): Float32Array | undefined {
  const bounds = inkBounds(field, width, height);
  if (!bounds) return undefined;

  const inkWidth = bounds.maxX - bounds.minX + 1;
  const inkHeight = bounds.maxY - bounds.minY + 1;
  // Preserve aspect ratio: the long side fills the 20 px box.
  const scale = DIGIT_BOX / Math.max(inkWidth, inkHeight);
  const boxWidth = Math.max(1, Math.round(inkWidth * scale));
  const boxHeight = Math.max(1, Math.round(inkHeight * scale));

  // Resample the cropped ink into boxWidth x boxHeight with a box filter.
  const box = new Float32Array(boxWidth * boxHeight);
  for (let y = 0; y < boxHeight; y++) {
    for (let x = 0; x < boxWidth; x++) {
      const x0 = bounds.minX + (x * inkWidth) / boxWidth;
      const x1 = bounds.minX + ((x + 1) * inkWidth) / boxWidth;
      const y0 = bounds.minY + (y * inkHeight) / boxHeight;
      const y1 = bounds.minY + ((y + 1) * inkHeight) / boxHeight;
      box[y * boxWidth + x] = sampleBox(field, width, height, x0, y0, x1, y1);
    }
  }

  // Centre of mass of the scaled glyph, then translate it to the field centre.
  let mass = 0;
  let momentX = 0;
  let momentY = 0;
  for (let y = 0; y < boxHeight; y++) {
    for (let x = 0; x < boxWidth; x++) {
      const value = box[y * boxWidth + x]!;
      mass += value;
      momentX += value * (x + 0.5);
      momentY += value * (y + 0.5);
    }
  }
  const centreX = mass > 0 ? momentX / mass : boxWidth / 2;
  const centreY = mass > 0 ? momentY / mass : boxHeight / 2;
  const offsetX = Math.round(INPUT_SIZE / 2 - centreX);
  const offsetY = Math.round(INPUT_SIZE / 2 - centreY);

  const pixels = new Float32Array(INPUT_SIZE * INPUT_SIZE);
  for (let y = 0; y < boxHeight; y++) {
    const targetY = y + offsetY;
    if (targetY < 0 || targetY >= INPUT_SIZE) continue;
    for (let x = 0; x < boxWidth; x++) {
      const targetX = x + offsetX;
      if (targetX < 0 || targetX >= INPUT_SIZE) continue;
      pixels[targetY * INPUT_SIZE + targetX] = Math.min(1, Math.max(0, box[y * boxWidth + x]!));
    }
  }
  return pixels;
}

/** FNV-1a over quantized values; pins fixtures without storing 784 floats twice. */
export function hashPixels(pixels: Float32Array): string {
  let hash = 0x811c9dc5;
  for (const value of pixels) {
    hash ^= Math.round(value * 255) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Numerically stable softmax, mirroring the shader's algorithm exactly. */
export function softmax(logits: ArrayLike<number>): Float32Array {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) max = Math.max(max, logits[i]!);
  const out = new Float32Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    const value = Math.exp(logits[i]! - max);
    out[i] = value;
    sum += value;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / sum;
  return out;
}

/** Index of the largest logit. */
export function argmax(logits: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < logits.length; i++) if (logits[i]! > logits[best]!) best = i;
  return best;
}
