/**
 * The crop that builds both model inputs, and the single mirror in the system.
 *
 * The CPU implementation under test here is the *reference*, not the production
 * path — production samples the camera texture in `hand-crop.wgsl`. Its job is
 * to be simple enough to be obviously right, so the shader has something to be
 * compared against. The gate measured that agreement at 2.8e-07 mean absolute
 * error on real hardware.
 */
import { describe, expect, it } from 'vitest';
import {
  brushToSource,
  cropForLandmarks,
  cropToNhwcFloat32,
  detectorRoi,
  letterboxForDetector,
  sourceToBrush,
  type RgbaImage,
} from './hand-preprocess';
import {
  DETECTOR_INPUT_ELEMENTS,
  DETECTOR_SIZE,
  LANDMARK_INPUT_ELEMENTS,
  LANDMARK_SIZE,
} from './hand-model-contract';
import { cropToSource, type HandRoi } from './hand-pipeline';
import {
  createFixtureFrame,
  FIXTURE_FRAME_BYTES,
  FIXTURE_FRAME_HASH,
  FIXTURE_FRAME_HEIGHT,
  FIXTURE_FRAME_WIDTH,
  hashBytes,
} from './fixtures';

/** A flat image whose red channel encodes x and green channel encodes y. */
function rampImage(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = Math.round((x / Math.max(1, width - 1)) * 255);
      data[i + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

function pixelAt(out: Float32Array, size: number, x: number, y: number): [number, number, number] {
  const base = (y * size + x) * 3;
  return [out[base]!, out[base + 1]!, out[base + 2]!];
}

describe('detector letterbox as an ROI', () => {
  it('covers the whole frame with the long edge', () => {
    const roi = detectorRoi(640, 360);
    expect(roi.cx).toBe(320);
    expect(roi.cy).toBe(180);
    expect(roi.size).toBe(640);
    expect(roi.rotation).toBe(0);
  });

  it('pads the short axis rather than cropping it', () => {
    // Losing the top and bottom of a 16:9 frame would lose the hands, which are
    // usually held high.
    const roi = detectorRoi(640, 360);
    const top = cropToSource({ x: 0.5, y: 0 }, roi);
    const bottom = cropToSource({ x: 0.5, y: 1 }, roi);
    expect(top.y).toBeLessThan(0);
    expect(bottom.y).toBeGreaterThan(360);
    // ...while the long axis fits exactly.
    expect(cropToSource({ x: 0, y: 0.5 }, roi).x).toBeCloseTo(0, 8);
    expect(cropToSource({ x: 1, y: 0.5 }, roi).x).toBeCloseTo(640, 8);
  });

  it('rejects a degenerate frame size', () => {
    expect(() => detectorRoi(0, 360)).toThrow();
    expect(() => detectorRoi(640, -1)).toThrow();
  });

  it('produces the exact element count the detector declares', () => {
    const image = rampImage(64, 36);
    const out = letterboxForDetector(image);
    expect(out).toHaveLength(DETECTOR_INPUT_ELEMENTS);
    expect(DETECTOR_INPUT_ELEMENTS).toBe(DETECTOR_SIZE * DETECTOR_SIZE * 3);
  });

  it('fills the padding with black, exactly', () => {
    const image = rampImage(64, 36);
    const out = letterboxForDetector(image);
    // Top row of a 16:9 frame in a square is padding.
    expect(pixelAt(out, DETECTOR_SIZE, DETECTOR_SIZE / 2, 0)).toEqual([0, 0, 0]);
    expect(pixelAt(out, DETECTOR_SIZE, DETECTOR_SIZE / 2, DETECTOR_SIZE - 1)).toEqual([0, 0, 0]);
    // The middle is real content.
    const centre = pixelAt(out, DETECTOR_SIZE, DETECTOR_SIZE / 2, DETECTOR_SIZE / 2);
    expect(centre[0]).toBeGreaterThan(0);
  });

  it('does not mirror: the models must see the raw frame', () => {
    const image = rampImage(64, 64);
    const out = cropToNhwcFloat32(image, detectorRoi(64, 64), 64);
    // Red encodes x, so a mirror would make the left edge bright.
    const left = pixelAt(out, 64, 1, 32)[0];
    const right = pixelAt(out, 64, 62, 32)[0];
    expect(left).toBeLessThan(right);
  });
});

describe('landmark crop', () => {
  const image = rampImage(128, 128);

  it('produces the exact element count the landmark graph declares', () => {
    const out = cropForLandmarks(image, { cx: 64, cy: 64, size: 40, rotation: 0 });
    expect(out).toHaveLength(LANDMARK_INPUT_ELEMENTS);
    expect(LANDMARK_INPUT_ELEMENTS).toBe(LANDMARK_SIZE * LANDMARK_SIZE * 3);
  });

  it('samples the ROI centre at the centre of the crop', () => {
    const roi: HandRoi = { cx: 32, cy: 96, size: 20, rotation: 0 };
    const out = cropToNhwcFloat32(image, roi, 32);
    const middle = pixelAt(out, 32, 16, 16);
    // Red ~ x/127, green ~ y/127 at the ROI centre.
    expect(middle[0]).toBeCloseTo(32 / 127, 1);
    expect(middle[1]).toBeCloseTo(96 / 127, 1);
  });

  it('rotating the ROI rotates the sampled content', () => {
    const upright = cropToNhwcFloat32(image, { cx: 64, cy: 64, size: 40, rotation: 0 }, 32);
    const turned = cropToNhwcFloat32(
      image,
      { cx: 64, cy: 64, size: 40, rotation: Math.PI / 2 },
      32,
    );
    // A quarter turn swaps which axis the red ramp runs along.
    const uprightAcross = pixelAt(upright, 32, 28, 16)[0] - pixelAt(upright, 32, 4, 16)[0];
    const turnedAcross = pixelAt(turned, 32, 28, 16)[0] - pixelAt(turned, 32, 4, 16)[0];
    expect(Math.abs(uprightAcross)).toBeGreaterThan(0.1);
    expect(Math.abs(turnedAcross)).toBeLessThan(Math.abs(uprightAcross) / 2);
  });

  it('writes black outside the frame instead of wrapping the far side in', () => {
    // A hand at the very corner: most of the crop falls outside.
    const out = cropToNhwcFloat32(image, { cx: 0, cy: 0, size: 40, rotation: 0 }, 32);
    expect(pixelAt(out, 32, 2, 2)).toEqual([0, 0, 0]);
    // ...but the quadrant that is inside still has content.
    expect(pixelAt(out, 32, 24, 24)[2]).toBeGreaterThan(0);
  });

  it('keeps every sample in [0,1]', () => {
    const out = cropForLandmarks(image, { cx: 40, cy: 70, size: 60, rotation: 0.7 });
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(0);
      expect(out[i]).toBeLessThanOrEqual(1);
    }
  });

  it('reuses a caller-supplied buffer instead of allocating per frame', () => {
    const out = new Float32Array(LANDMARK_INPUT_ELEMENTS);
    expect(cropForLandmarks(image, { cx: 64, cy: 64, size: 40, rotation: 0 }, out)).toBe(out);
  });

  it('rejects an undersized output buffer', () => {
    expect(() =>
      cropToNhwcFloat32(image, { cx: 64, cy: 64, size: 40, rotation: 0 }, 32, new Float32Array(8)),
    ).toThrow();
  });

  it('is deterministic', () => {
    const roi: HandRoi = { cx: 50, cy: 70, size: 30, rotation: 0.4 };
    expect(Array.from(cropToNhwcFloat32(image, roi, 16))).toEqual(
      Array.from(cropToNhwcFloat32(image, roi, 16)),
    );
  });
});

describe('the single mirror', () => {
  it('flips x and normalizes, and nothing else', () => {
    const brush = sourceToBrush({ x: 160, y: 90 }, 640, 360);
    expect(brush.x).toBeCloseTo(0.75, 12);
    expect(brush.y).toBeCloseTo(0.25, 12);
  });

  it('round-trips through source space', () => {
    for (const point of [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
      { x: 0.2, y: 0.9 },
    ]) {
      const back = sourceToBrush(brushToSource(point, 640, 360), 640, 360);
      expect(back.x).toBeCloseTo(point.x, 12);
      expect(back.y).toBeCloseTo(point.y, 12);
    }
  });

  it('maps the frame corners to the corners of brush space, mirrored', () => {
    expect(sourceToBrush({ x: 0, y: 0 }, 640, 360)).toEqual({ x: 1, y: 0 });
    expect(sourceToBrush({ x: 640, y: 360 }, 640, 360)).toEqual({ x: 0, y: 1 });
  });
});

describe('canned fixture frame', () => {
  const frame = createFixtureFrame();

  it('is a deterministic, fully opaque RGBA image of the expected size', () => {
    expect(frame).toHaveLength(FIXTURE_FRAME_BYTES);
    expect(FIXTURE_FRAME_BYTES).toBe(FIXTURE_FRAME_WIDTH * FIXTURE_FRAME_HEIGHT * 4);
    for (let i = 3; i < frame.length; i += 4) expect(frame[i]).toBe(255);
    expect(Array.from(createFixtureFrame())).toEqual(Array.from(frame));
  });

  it('pins its content hash so a visual change has to be deliberate', () => {
    // Unchanged by the hand swap: this is the camera stand-in, and swapping the
    // estimator does not change what a camera would have seen.
    expect(hashBytes(frame)).toBe(FIXTURE_FRAME_HASH);
  });

  it('has real local colour variance, which the thumbnail check depends on', () => {
    let min = 255;
    let max = 0;
    for (let i = 0; i < frame.length; i += 4) {
      min = Math.min(min, frame[i]!);
      max = Math.max(max, frame[i]!);
    }
    expect(max - min).toBeGreaterThan(60);
  });

  it('is neutral greyscale, so the frost lift cannot clip it to white', () => {
    for (let i = 0; i < frame.length; i += 4) {
      expect(frame[i]).toBe(frame[i + 1]);
      expect(frame[i + 1]).toBe(frame[i + 2]);
    }
  });
});
