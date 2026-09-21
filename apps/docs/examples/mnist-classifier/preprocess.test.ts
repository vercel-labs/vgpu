import { describe, expect, it } from "vitest";
import {
  DIGIT_BOX,
  foregroundFromRgba,
  inkBounds,
  INPUT_SIZE,
  preprocessDigit,
} from "./preprocess";

describe("MNIST preprocessing", () => {
  it("converts RGBA luminance and alpha to foreground", () => {
    const rgba = new Uint8ClampedArray([
      0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 0,
    ]);
    expect([...foregroundFromRgba(rgba, 3, 1)]).toEqual([0, 1, 0]);
    expect(() => foregroundFromRgba(rgba, 2, 2)).toThrow(
      /Expected 16 RGBA bytes/
    );
  });

  it("returns no input for an empty drawing", () => {
    expect(preprocessDigit(new Float32Array(100), 10, 10)).toBeUndefined();
  });

  it("crops, preserves aspect ratio, and centres the digit", () => {
    const field = new Float32Array(100 * 100);
    for (let y = 45; y < 55; y++) {
      for (let x = 10; x < 90; x++) field[y * 100 + x] = 1;
    }

    const pixels = preprocessDigit(field, 100, 100)!;
    const bounds = inkBounds(pixels, INPUT_SIZE, INPUT_SIZE)!;
    expect(pixels).toHaveLength(INPUT_SIZE * INPUT_SIZE);
    expect(bounds.maxX - bounds.minX + 1).toBe(DIGIT_BOX);
    expect(bounds.maxY - bounds.minY + 1).toBeLessThanOrEqual(4);

    let mass = 0;
    let xMoment = 0;
    let yMoment = 0;
    for (let y = 0; y < INPUT_SIZE; y++) {
      for (let x = 0; x < INPUT_SIZE; x++) {
        const value = pixels[y * INPUT_SIZE + x]!;
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        mass += value;
        xMoment += value * (x + 0.5);
        yMoment += value * (y + 0.5);
      }
    }
    expect(Math.abs(xMoment / mass - INPUT_SIZE / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(yMoment / mass - INPUT_SIZE / 2)).toBeLessThanOrEqual(1);
  });
});
