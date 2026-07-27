import { describe, expect, it } from 'vitest';
import { coverCrop, rgbaToNchw } from './preprocess';

describe('coverCrop', () => {
  it('trims the sides of a source wider than the target', () => {
    const crop = coverCrop(1000, 500, 4, 2); // target 2:1, source 2:1 -> no trim
    expect(crop).toEqual({ sx: 0, sy: 0, sw: 1000, sh: 500 });
  });

  it('crops width when the source is wider than the target aspect', () => {
    const crop = coverCrop(1600, 800, 1, 1);
    expect(crop.sw).toBe(800);
    expect(crop.sh).toBe(800);
    expect(crop.sx).toBe(400); // centred
    expect(crop.sy).toBe(0);
  });

  it('crops height when the source is taller than the target aspect', () => {
    const crop = coverCrop(800, 1600, 1, 1);
    expect(crop.sw).toBe(800);
    expect(crop.sh).toBe(800);
    expect(crop.sx).toBe(0);
    expect(crop.sy).toBe(400);
  });

  it('keeps the 5:4 crop the depth models expect', () => {
    const crop = coverCrop(1280, 964, 320, 256);
    expect(crop.sw / crop.sh).toBeCloseTo(320 / 256, 2);
  });

  it('rejects degenerate sizes instead of producing an empty crop', () => {
    expect(() => coverCrop(0, 10, 4, 4)).toThrow(/Invalid source size/);
    expect(() => coverCrop(10, 10, 0, 4)).toThrow(/Invalid target size/);
  });
});

describe('rgbaToNchw', () => {
  /** Two pixels: pure red, then mid grey with a non-opaque alpha. */
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 128, 128, 128, 7]);

  it('packs planar channels and scales to 0..1', () => {
    const out = rgbaToNchw(rgba, 2, 1, 'rgb255');
    expect(out).toHaveLength(6);
    // Plane layout: [r0 r1, g0 g1, b0 b1]
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(128 / 255, 6);
    expect(out[2]).toBeCloseTo(0, 6);
    expect(out[3]).toBeCloseTo(128 / 255, 6);
    expect(out[4]).toBeCloseTo(0, 6);
    expect(out[5]).toBeCloseTo(128 / 255, 6);
  });

  it('ignores alpha entirely', () => {
    const opaque = new Uint8ClampedArray([255, 0, 0, 255, 128, 128, 128, 255]);
    expect(Array.from(rgbaToNchw(opaque, 2, 1, 'rgb255'))).toEqual(
      Array.from(rgbaToNchw(rgba, 2, 1, 'rgb255')),
    );
  });

  it('applies ImageNet statistics only when asked', () => {
    const out = rgbaToNchw(rgba, 2, 1, 'imagenet');
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(out[2]).toBeCloseTo((0 - 0.456) / 0.224, 5);
  });

  it('refuses a buffer too short for the stated size', () => {
    expect(() => rgbaToNchw(rgba, 4, 4, 'rgb255')).toThrow(/Expected 64 RGBA bytes/);
  });
});
