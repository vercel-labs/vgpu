/**
 * CPU camera preprocessing for the air-painting example.
 *
 * This is the honest, sanctioned fallback from the plan's Phase 0: the model
 * input is **uint8** `[1,192,192,3]`, and the GPU-buffer input probe on real
 * hardware was rejected outright
 * (`Unexpected input data type. Actual: (tensor(int32)), expected: (tensor(uint8))`).
 * So the frame is letterboxed on the CPU and uploaded once per inference.
 *
 * What that costs, stated plainly: 110,592 bytes per inference, one
 * `drawImage` + one `getImageData` per inference (not per displayed frame). The
 * **output** side is what this example is about — the 17 keypoints stay
 * GPU-resident and are consumed zero-copy, never read back.
 *
 * The module is DOM-light on purpose: the pixel work is pure functions over
 * typed arrays so it is unit-testable without a canvas, and the only browser
 * dependency is an injected 2D context.
 */
import {
  computeFrameTransform,
  MODEL_INPUT_ELEMENTS,
  MODEL_INPUT_SIZE,
  type FrameTransform,
} from './pose-contract';

/** Anything `drawImage` accepts and we actually use. */
export type FrameImageSource = CanvasImageSource;

/** Minimal 2D context surface used here, so tests can pass a fake. */
export interface LetterboxContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(
    image: FrameImageSource,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number,
  ): void;
  getImageData(x: number, y: number, width: number, height: number): ImageData;
}

/**
 * Drops alpha from tightly packed RGBA into the NHWC RGB uint8 the graph wants.
 *
 * `out` is reused across inferences on purpose; allocating 110 kB per frame
 * would be the only real cost of this path.
 */
export function packRgb(
  rgba: Uint8ClampedArray | Uint8Array,
  out: Uint8Array = new Uint8Array(MODEL_INPUT_ELEMENTS),
): Uint8Array {
  const texels = rgba.length / 4;
  if (!Number.isInteger(texels)) {
    throw new Error(`RGBA input length ${rgba.length} is not a multiple of 4.`);
  }
  if (out.length < texels * 3) {
    throw new Error(`Output needs ${texels * 3} bytes, received ${out.length}.`);
  }
  for (let texel = 0; texel < texels; texel++) {
    const from = texel * 4;
    const to = texel * 3;
    out[to] = rgba[from]!;
    out[to + 1] = rgba[from + 1]!;
    out[to + 2] = rgba[from + 2]!;
  }
  return out;
}

/**
 * Letterbox rectangle for `drawImage`, rounded to whole model pixels so the
 * canvas and the transform agree about where the content starts.
 */
export function letterboxRect(transform: FrameTransform): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  return {
    x: transform.padX,
    y: transform.padY,
    width: transform.drawWidth,
    height: transform.drawHeight,
  };
}

export interface FramePreprocessor {
  readonly transform: FrameTransform;
  /**
   * Letterboxes `frame` into the 192x192 square and returns the uint8 NHWC RGB
   * view. The returned array is reused; copy it if it must outlive the next call.
   */
  read(frame: FrameImageSource): Uint8Array;
  /** Recomputes the transform after the camera renegotiates its resolution. */
  resize(sourceWidth: number, sourceHeight: number): FrameTransform;
}

export interface FramePreprocessorOptions {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly context: LetterboxContext;
  readonly modelSize?: number;
}

/**
 * Builds the CPU preprocessor around a caller-owned 2D context sized
 * `modelSize x modelSize`.
 *
 * The frame is **not** mirrored here. MoveNet infers anatomical left/right from
 * appearance, so mirroring the input would swap the wrists and index 10 would
 * stop being the user's right hand. Mirroring happens in `wrist.wgsl` and
 * `composite.wgsl` instead; see `pose-contract.ts` for the coordinate spaces.
 */
export function createFramePreprocessor(options: FramePreprocessorOptions): FramePreprocessor {
  const modelSize = options.modelSize ?? MODEL_INPUT_SIZE;
  const rgb = new Uint8Array(modelSize * modelSize * 3);
  let transform = computeFrameTransform(options.sourceWidth, options.sourceHeight, modelSize);

  return {
    get transform() {
      return transform;
    },
    resize(sourceWidth, sourceHeight) {
      transform = computeFrameTransform(sourceWidth, sourceHeight, modelSize);
      return transform;
    },
    read(frame) {
      const { context } = options;
      // Padding must be black: MoveNet sees it as image content, and the shader
      // rejects any keypoint that lands inside it.
      context.fillStyle = '#000000';
      context.fillRect(0, 0, modelSize, modelSize);
      const rect = letterboxRect(transform);
      context.drawImage(frame, rect.x, rect.y, rect.width, rect.height);
      const image = context.getImageData(0, 0, modelSize, modelSize);
      return packRgb(image.data, rgb);
    },
  };
}
