export const INPUT_SIZE = 28;
export const DIGIT_BOX = 20;
const INK_THRESHOLD = 0.08;

export function foregroundFromRgba(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): Float32Array {
  const expected = width * height * 4;
  if (data.length !== expected) {
    throw new Error(
      `Expected ${expected} RGBA bytes for ${width}x${height}, received ${data.length}.`
    );
  }
  const field = new Float32Array(width * height);
  for (let byte = 0, pixel = 0; byte < data.length; byte += 4, pixel++) {
    const luma =
      (0.299 * data[byte]! +
        0.587 * data[byte + 1]! +
        0.114 * data[byte + 2]!) /
      255;
    field[pixel] = luma * (data[byte + 3]! / 255);
  }
  return field;
}

export function inkBounds(field: Float32Array, width: number, height: number) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (field[y * width + x]! <= INK_THRESHOLD) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? undefined : { minX, minY, maxX, maxY };
}

function sampleBox(
  field: Float32Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
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
  return count ? sum / count : 0;
}

/** Crops, scales into a 20px box, then centres the glyph by mass. */
export function preprocessDigit(
  field: Float32Array,
  width: number,
  height: number
): Float32Array | undefined {
  const bounds = inkBounds(field, width, height);
  if (!bounds) return;

  const inkWidth = bounds.maxX - bounds.minX + 1;
  const inkHeight = bounds.maxY - bounds.minY + 1;
  const scale = DIGIT_BOX / Math.max(inkWidth, inkHeight);
  const boxWidth = Math.max(1, Math.round(inkWidth * scale));
  const boxHeight = Math.max(1, Math.round(inkHeight * scale));
  const box = new Float32Array(boxWidth * boxHeight);
  for (let y = 0; y < boxHeight; y++) {
    for (let x = 0; x < boxWidth; x++) {
      box[y * boxWidth + x] = sampleBox(
        field,
        width,
        height,
        bounds.minX + (x * inkWidth) / boxWidth,
        bounds.minY + (y * inkHeight) / boxHeight,
        bounds.minX + ((x + 1) * inkWidth) / boxWidth,
        bounds.minY + ((y + 1) * inkHeight) / boxHeight
      );
    }
  }

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
  const offsetX = Math.round(
    INPUT_SIZE / 2 - (mass ? momentX / mass : boxWidth / 2)
  );
  const offsetY = Math.round(
    INPUT_SIZE / 2 - (mass ? momentY / mass : boxHeight / 2)
  );
  const pixels = new Float32Array(INPUT_SIZE * INPUT_SIZE);
  for (let y = 0; y < boxHeight; y++) {
    const targetY = y + offsetY;
    if (targetY < 0 || targetY >= INPUT_SIZE) continue;
    for (let x = 0; x < boxWidth; x++) {
      const targetX = x + offsetX;
      if (targetX < 0 || targetX >= INPUT_SIZE) continue;
      pixels[targetY * INPUT_SIZE + targetX] = Math.min(
        1,
        Math.max(0, box[y * boxWidth + x]!)
      );
    }
  }
  return pixels;
}
