import { describe, expect, it, vi } from 'vitest';
import { computeFrameTransform, MODEL_INPUT_ELEMENTS, MODEL_INPUT_SIZE } from './pose-contract';
import { createFramePreprocessor, letterboxRect, packRgb, type LetterboxContext } from './preprocess';
import { createFixtureFrame, FIXTURE_FRAME_HASH, hashBytes } from './fixtures';

/** Minimal 2D context stand-in: records calls and serves canned pixels. */
function createFakeContext(pixels?: Uint8ClampedArray) {
  const calls: string[] = [];
  const data =
    pixels ?? new Uint8ClampedArray(MODEL_INPUT_SIZE * MODEL_INPUT_SIZE * 4).fill(0);
  const context: LetterboxContext = {
    fillStyle: '',
    fillRect(x, y, width, height) {
      calls.push(`fillRect ${x} ${y} ${width} ${height} ${String(context.fillStyle)}`);
    },
    drawImage(_image, dx, dy, dWidth, dHeight) {
      calls.push(`drawImage ${dx} ${dy} ${dWidth} ${dHeight}`);
    },
    getImageData(x, y, width, height) {
      calls.push(`getImageData ${x} ${y} ${width} ${height}`);
      return { data, width, height, colorSpace: 'srgb' } as unknown as ImageData;
    },
  };
  return { context, calls };
}

describe('packRgb', () => {
  it('drops alpha and keeps NHWC RGB order', () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 128]);
    expect(Array.from(packRgb(rgba, new Uint8Array(6)))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('produces exactly 110,592 bytes for a 192x192 frame', () => {
    const rgba = new Uint8ClampedArray(MODEL_INPUT_SIZE * MODEL_INPUT_SIZE * 4);
    expect(packRgb(rgba).length).toBe(MODEL_INPUT_ELEMENTS);
  });

  it('reuses the supplied output buffer instead of allocating per frame', () => {
    const out = new Uint8Array(6);
    const rgba = new Uint8ClampedArray([9, 9, 9, 255, 8, 8, 8, 255]);
    expect(packRgb(rgba, out)).toBe(out);
  });

  it('rejects a malformed RGBA length and an undersized output', () => {
    expect(() => packRgb(new Uint8ClampedArray(7))).toThrow(/multiple of 4/);
    expect(() => packRgb(new Uint8ClampedArray(8), new Uint8Array(5))).toThrow(/Output needs/);
  });

  it('never emits a value outside 0..255', () => {
    const rgba = new Uint8ClampedArray([0, 128, 255, 255]);
    const packed = packRgb(rgba, new Uint8Array(3));
    for (const value of packed) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(255);
    }
  });
});

describe('letterboxRect', () => {
  it('matches the transform so the canvas and the maths agree', () => {
    const transform = computeFrameTransform(1280, 720);
    expect(letterboxRect(transform)).toEqual({
      x: transform.padX,
      y: transform.padY,
      width: transform.drawWidth,
      height: transform.drawHeight,
    });
  });
});

describe('frame preprocessor', () => {
  it('clears to black then letterboxes without stretching', () => {
    const { context, calls } = createFakeContext();
    const preprocessor = createFramePreprocessor({
      sourceWidth: 1280,
      sourceHeight: 720,
      context,
    });
    preprocessor.read({} as CanvasImageSource);

    expect(calls[0]).toBe('fillRect 0 0 192 192 #000000');
    // 1280x720 -> 192x108 centred vertically.
    expect(calls[1]).toBe('drawImage 0 42 192 108');
    expect(calls[2]).toBe('getImageData 0 0 192 192');
  });

  it('returns the same reused uint8 view every call', () => {
    const { context } = createFakeContext();
    const preprocessor = createFramePreprocessor({
      sourceWidth: 640,
      sourceHeight: 480,
      context,
    });
    const first = preprocessor.read({} as CanvasImageSource);
    const second = preprocessor.read({} as CanvasImageSource);
    expect(first).toBe(second);
    expect(first.length).toBe(MODEL_INPUT_ELEMENTS);
  });

  it('does not mirror: the model must see the raw frame so index 10 stays the right wrist', () => {
    // Two-texel canned image: red on the left, blue on the right.
    const pixels = new Uint8ClampedArray(MODEL_INPUT_SIZE * MODEL_INPUT_SIZE * 4);
    pixels[0] = 255;
    pixels[4] = 0;
    pixels[6] = 255;
    const { context } = createFakeContext(pixels);
    const preprocessor = createFramePreprocessor({
      sourceWidth: 640,
      sourceHeight: 360,
      context,
    });
    const rgb = preprocessor.read({} as CanvasImageSource);
    // Byte order follows the source, unflipped.
    expect(Array.from(rgb.subarray(0, 6))).toEqual([255, 0, 0, 0, 0, 255]);
  });

  it('recomputes the transform when the camera renegotiates its resolution', () => {
    const { context, calls } = createFakeContext();
    const preprocessor = createFramePreprocessor({
      sourceWidth: 640,
      sourceHeight: 360,
      context,
    });
    expect(preprocessor.transform.padY).toBeCloseTo(42, 10);
    preprocessor.resize(480, 640);
    expect(preprocessor.transform.padY).toBeCloseTo(0, 10);
    expect(preprocessor.transform.padX).toBeCloseTo(24, 10);
    preprocessor.read({} as CanvasImageSource);
    expect(calls.at(-2)).toBe('drawImage 24 0 144 192');
  });

  it('forwards the caller-supplied frame to drawImage untouched', () => {
    const drawImage = vi.fn();
    const context: LetterboxContext = {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage,
      getImageData: () =>
        ({
          data: new Uint8ClampedArray(MODEL_INPUT_SIZE * MODEL_INPUT_SIZE * 4),
        }) as unknown as ImageData,
    };
    const frame = { marker: true } as unknown as CanvasImageSource;
    createFramePreprocessor({ sourceWidth: 640, sourceHeight: 360, context }).read(frame);
    expect(drawImage.mock.calls[0]?.[0]).toBe(frame);
  });
});

describe('canned fixture frame', () => {
  it('is a deterministic, fully opaque RGBA image of the expected size', () => {
    const frame = createFixtureFrame();
    expect(frame.length).toBe(640 * 360 * 4);
    for (let i = 3; i < frame.length; i += 4 * 977) expect(frame[i]).toBe(255);
    expect(hashBytes(frame)).toBe(hashBytes(createFixtureFrame()));
  });

  it('pins its content hash so a visual change has to be deliberate', () => {
    expect(hashBytes(createFixtureFrame())).toBe(FIXTURE_FRAME_HASH);
  });

  it('has real local colour variance, which the thumbnail check depends on', () => {
    const frame = createFixtureFrame();
    const values: number[] = [];
    for (let i = 0; i < frame.length; i += 4 * 313) values.push(frame[i]!);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    expect(variance).toBeGreaterThan(50);
  });
});
