import { describe, expect, it } from 'vitest';
import {
  createFixtureDigit,
  FIXTURE_LABEL,
  FIXTURE_PIXEL_HASH,
  FIXTURE_STROKES,
  FIXTURE_SURFACE,
  GOLDEN_LOGITS,
  LOGIT_BYTES,
  LOGIT_COUNT,
  MODEL_BYTES,
  MODEL_SHA256,
  rasterizeStrokes,
} from './fixtures';
import {
  argmax,
  DIGIT_BOX,
  foregroundFromRgba,
  hashPixels,
  inkBounds,
  INPUT_SIZE,
  preprocessDigit,
  softmax,
} from './preprocess';

function rgbaFromField(field: Float32Array): Uint8ClampedArray {
  const data = new Uint8ClampedArray(field.length * 4);
  field.forEach((value, index) => {
    const byte = Math.round(value * 255);
    data[index * 4] = byte;
    data[index * 4 + 1] = byte;
    data[index * 4 + 2] = byte;
    data[index * 4 + 3] = 255;
  });
  return data;
}

describe('foregroundFromRgba', () => {
  it('maps white ink on black to [0, 1] and rejects wrong sizes', () => {
    const field = new Float32Array([0, 1, 0.5, 0]);
    const data = rgbaFromField(field);
    const result = foregroundFromRgba(data, 2, 2);
    expect(result[0]).toBeCloseTo(0, 3);
    expect(result[1]).toBeCloseTo(1, 2);
    expect(result[2]).toBeCloseTo(0.5, 2);
    expect(() => foregroundFromRgba(data, 3, 3)).toThrow(/Expected 36 RGBA bytes/);
  });

  it('treats transparent pixels as background', () => {
    const data = new Uint8ClampedArray([255, 255, 255, 0]);
    expect(foregroundFromRgba(data, 1, 1)[0]).toBe(0);
  });
});

describe('inkBounds', () => {
  it('returns undefined for an empty field', () => {
    expect(inkBounds(new Float32Array(16), 4, 4)).toBeUndefined();
  });

  it('finds the tight bounding box of ink', () => {
    const field = new Float32Array(25);
    field[1 * 5 + 2] = 1;
    field[3 * 5 + 4] = 1;
    expect(inkBounds(field, 5, 5)).toEqual({ minX: 2, minY: 1, maxX: 4, maxY: 3 });
  });
});

describe('preprocessDigit', () => {
  it('returns undefined when nothing is drawn', () => {
    expect(preprocessDigit(new Float32Array(FIXTURE_SURFACE * FIXTURE_SURFACE), FIXTURE_SURFACE, FIXTURE_SURFACE)).toBeUndefined();
  });

  it('emits exactly 784 finite values in [0, 1]', () => {
    const pixels = createFixtureDigit();
    expect(pixels.length).toBe(INPUT_SIZE * INPUT_SIZE);
    expect(pixels.length).toBe(784);
    for (const value of pixels) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the glyph inside a 20x20 box and centres it', () => {
    const pixels = createFixtureDigit();
    const bounds = inkBounds(pixels, INPUT_SIZE, INPUT_SIZE);
    expect(bounds).toBeDefined();
    const width = bounds!.maxX - bounds!.minX + 1;
    const height = bounds!.maxY - bounds!.minY + 1;
    expect(Math.max(width, height)).toBeLessThanOrEqual(DIGIT_BOX);
    // Centre of mass lands within a pixel or two of the field centre.
    let mass = 0;
    let momentX = 0;
    let momentY = 0;
    for (let y = 0; y < INPUT_SIZE; y++) {
      for (let x = 0; x < INPUT_SIZE; x++) {
        const value = pixels[y * INPUT_SIZE + x]!;
        mass += value;
        momentX += value * (x + 0.5);
        momentY += value * (y + 0.5);
      }
    }
    expect(momentX / mass).toBeCloseTo(INPUT_SIZE / 2, 0);
    expect(momentY / mass).toBeCloseTo(INPUT_SIZE / 2, 0);
  });

  it('preserves aspect ratio for a wide stroke', () => {
    const width = 100;
    const height = 100;
    const field = new Float32Array(width * height);
    for (let x = 10; x < 90; x++) {
      for (let y = 45; y < 55; y++) field[y * width + x] = 1;
    }
    const pixels = preprocessDigit(field, width, height)!;
    const bounds = inkBounds(pixels, INPUT_SIZE, INPUT_SIZE)!;
    const outWidth = bounds.maxX - bounds.minX + 1;
    const outHeight = bounds.maxY - bounds.minY + 1;
    expect(outWidth).toBe(DIGIT_BOX);
    // 80x10 ink scaled by 20/80 gives a 20x2..3 box, never a stretched square.
    expect(outHeight).toBeLessThanOrEqual(4);
  });
});

describe('fixtures', () => {
  it('rasterizes the seeded strokes into the drawing surface', () => {
    const field = rasterizeStrokes();
    expect(field.length).toBe(FIXTURE_SURFACE * FIXTURE_SURFACE);
    const bounds = inkBounds(field, FIXTURE_SURFACE, FIXTURE_SURFACE)!;
    expect(bounds.minX).toBeGreaterThan(0);
    expect(bounds.maxX).toBeLessThan(FIXTURE_SURFACE - 1);
    expect(FIXTURE_STROKES.length).toBeGreaterThan(0);
  });

  it('pins the normalized fixture so preprocessing changes are deliberate', () => {
    expect(hashPixels(createFixtureDigit())).toBe(FIXTURE_PIXEL_HASH);
  });

  it('pins the committed model bytes', () => {
    expect(MODEL_SHA256).toBe('5c688690f8bacf667d4c2074af5ad0646ca328d7ab03eccf944a65b320171bdd');
    expect(MODEL_BYTES).toBe(26_143);
  });

  it('golden logits classify the fixture as its label', () => {
    expect(GOLDEN_LOGITS.length).toBe(LOGIT_COUNT);
    expect(LOGIT_BYTES).toBe(40);
    expect(argmax(GOLDEN_LOGITS)).toBe(FIXTURE_LABEL);
  });
});

describe('softmax', () => {
  it('matches the shader algorithm: stable, normalized, order preserving', () => {
    const probabilities = softmax(GOLDEN_LOGITS);
    const total = probabilities.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(argmax(probabilities)).toBe(FIXTURE_LABEL);
    expect(probabilities[FIXTURE_LABEL]!).toBeGreaterThan(0.99);
  });

  it('stays finite for large logits', () => {
    const probabilities = softmax([1000, 1001, -1000]);
    for (const value of probabilities) expect(Number.isFinite(value)).toBe(true);
    expect(probabilities[1]!).toBeGreaterThan(probabilities[0]!);
  });
});
