/**
 * Turns an image or video frame into the NCHW float input a depth model wants.
 *
 * Every model gets the identical framing — centre-crop to the model's aspect
 * ratio, then scale — so switching models changes the estimate, never the shot.
 * The pixel maths is split out from the Canvas2D work so it can be unit tested
 * without a DOM.
 */
import {
  IMAGENET_MEAN,
  IMAGENET_STD,
  type DepthModel,
  type Normalization,
} from './model-contract';

export interface CropRect {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

/**
 * Largest centred rectangle of `source` that matches the target aspect ratio.
 *
 * Cover, not contain: letterboxing would feed the network bars of dead pixels
 * and it would happily predict depth for them.
 */
export function coverCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): CropRect {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error(`Invalid source size ${sourceWidth}x${sourceHeight}.`);
  }
  if (targetWidth <= 0 || targetHeight <= 0) {
    throw new Error(`Invalid target size ${targetWidth}x${targetHeight}.`);
  }
  const target = targetWidth / targetHeight;
  let sw = sourceWidth;
  let sh = sourceHeight;
  if (sourceWidth / sourceHeight > target) sw = Math.round(sh * target);
  else sh = Math.round(sw / target);
  return { sx: Math.round((sourceWidth - sw) / 2), sy: Math.round((sourceHeight - sh) / 2), sw, sh };
}

/**
 * Packs RGBA bytes into planar NCHW float32.
 *
 * Index layout is `c * H * W + y * W + x`, which is what every one of these
 * graphs expects. Alpha is dropped.
 */
export function rgbaToNchw(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  normalization: Normalization,
): Float32Array {
  const pixels = width * height;
  if (rgba.length < pixels * 4) {
    throw new Error(`Expected ${pixels * 4} RGBA bytes for ${width}x${height}, got ${rgba.length}.`);
  }
  const out = new Float32Array(3 * pixels);
  const imagenet = normalization === 'imagenet';
  for (let p = 0; p < pixels; p += 1) {
    const base = p * 4;
    for (let c = 0; c < 3; c += 1) {
      const value = rgba[base + c]! / 255;
      out[c * pixels + p] = imagenet ? (value - IMAGENET_MEAN[c]!) / IMAGENET_STD[c]! : value;
    }
  }
  return out;
}

/** Canvas2D scratch space reused across frames so webcam mode stays allocation-light. */
export interface PreprocessScratch {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

export function createPreprocessScratch(width: number, height: number): PreprocessScratch {
  const canvas =
    typeof OffscreenCanvas === 'undefined'
      ? Object.assign(document.createElement('canvas'), { width, height })
      : new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!context) throw new Error('depth-estimation: 2D canvas context is unavailable.');
  return { canvas, context };
}

/** Intrinsic size of an image or video source. */
export function sourceSize(source: CanvasImageSource): { width: number; height: number } {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  const candidate = source as { width?: number; height?: number };
  return { width: Number(candidate.width ?? 0), height: Number(candidate.height ?? 0) };
}

export interface PreprocessedFrame {
  /** Planar NCHW input for the model. */
  readonly nchw: Float32Array;
  /** The same crop as RGBA8, uploaded as-is for the colour half of the view. */
  readonly rgba: Uint8ClampedArray;
}

/**
 * Full browser path: crop, scale, and normalize one frame for `model`.
 *
 * The CPU upload here is deliberate and unavoidable — the zero-copy claim in
 * this example is about the model's OUTPUT, which is never read back.
 */
export function preprocessDepthSource(
  source: CanvasImageSource,
  model: DepthModel,
  scratch: PreprocessScratch,
): PreprocessedFrame {
  const { width: sourceWidth, height: sourceHeight } = sourceSize(source);
  if (!sourceWidth || !sourceHeight) {
    throw new Error('depth-estimation: source has no intrinsic size yet.');
  }
  const { sx, sy, sw, sh } = coverCrop(sourceWidth, sourceHeight, model.width, model.height);
  const { canvas, context } = scratch;
  if (canvas.width !== model.width || canvas.height !== model.height) {
    canvas.width = model.width;
    canvas.height = model.height;
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, sx, sy, sw, sh, 0, 0, model.width, model.height);
  const { data } = context.getImageData(0, 0, model.width, model.height);
  return { nchw: rgbaToNchw(data, model.width, model.height, model.normalization), rgba: data };
}
