/**
 * Both model inputs, expressed as one operation.
 *
 * The palm detector wants the whole frame letterboxed into a 192x192 square; the
 * landmark model wants a tight, rotated 224x224 crop around one hand. Those look
 * like two different jobs, but a letterbox is just a rotation-free ROI centred on
 * the frame whose side is the frame's long edge — the padding falls out of the
 * same out-of-bounds rule that a rotated crop already needs. So there is one
 * transform, one shader (`hand-crop.wgsl`), and one reference implementation
 * here, which is why the two stages cannot drift apart.
 *
 * ## This is a GPU path
 *
 * Unlike the MoveNet version of this example, neither input is built on the CPU.
 * The camera frame is copied into a texture once per displayed frame and both
 * model inputs are sampled out of it by a compute shader straight into
 * `GPUBuffer`s that ONNX Runtime consumes directly. There is no `drawImage`, no
 * `getImageData`, and no per-frame upload.
 *
 * That was not a safe assumption to make in advance — it is the thing
 * `/hand-gate/` was built to prove, and it passed on real hardware with a
 * mean absolute error of 2.8e-07 against this reference. The functions below are
 * that reference: pure, typed-array-only, and used by the tests to hold the
 * shader honest.
 */
import { DETECTOR_SIZE, LANDMARK_SIZE } from './hand-model-contract';
import { cropToSource, type HandRoi, type Vec2 } from './hand-pipeline';

/**
 * The whole frame as a rotation-free ROI.
 *
 * Side is the **long** edge, so the short axis is padded rather than cropped:
 * losing the top and bottom of a 16:9 frame would lose the hands, which are
 * usually held high.
 */
export function detectorRoi(sourceWidth: number, sourceHeight: number): HandRoi {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new Error(`Frame size must be positive, received ${sourceWidth}x${sourceHeight}.`);
  }
  return {
    cx: sourceWidth / 2,
    cy: sourceHeight / 2,
    size: Math.max(sourceWidth, sourceHeight),
    rotation: 0,
  };
}

/** Tightly packed RGBA8 plus its dimensions; what the fixture frame produces. */
export interface RgbaImage {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * Bilinear sample of one channel, clamped at the edges.
 *
 * Edge clamping rather than wrapping matters for a rotated crop: a hand at the
 * frame border produces a crop whose corners fall outside, and wrapping would
 * fold the opposite side of the room into the sample.
 */
function sampleBilinear(image: RgbaImage, x: number, y: number, channel: number): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const clampX = (value: number) => Math.min(image.width - 1, Math.max(0, value));
  const clampY = (value: number) => Math.min(image.height - 1, Math.max(0, value));
  const x0c = clampX(x0);
  const x1c = clampX(x0 + 1);
  const y0c = clampY(y0);
  const y1c = clampY(y0 + 1);
  const at = (px: number, py: number) => image.data[(py * image.width + px) * 4 + channel] ?? 0;
  const top = at(x0c, y0c) * (1 - tx) + at(x1c, y0c) * tx;
  const bottom = at(x0c, y1c) * (1 - tx) + at(x1c, y1c) * tx;
  return (top * (1 - ty) + bottom * ty) / 255;
}

/**
 * CPU reference for `hand-crop.wgsl`: samples `image` through `roi` into the
 * NHWC float32 `[1, size, size, 3]` both graphs take.
 *
 * Anything outside the frame is black, which is both MediaPipe's border mode and
 * what makes the letterbox case fall out for free.
 */
export function cropToNhwcFloat32(
  image: RgbaImage,
  roi: HandRoi,
  size: number,
  out: Float32Array = new Float32Array(size * size * 3),
): Float32Array {
  if (out.length < size * size * 3) {
    throw new Error(`Crop output needs ${size * size * 3} floats, received ${out.length}.`);
  }
  for (let j = 0; j < size; j++) {
    const v = (j + 0.5) / size;
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size;
      const source = cropToSource({ x: u, y: v }, roi);
      const base = (j * size + i) * 3;
      if (
        source.x < 0 ||
        source.x >= image.width ||
        source.y < 0 ||
        source.y >= image.height
      ) {
        out[base] = 0;
        out[base + 1] = 0;
        out[base + 2] = 0;
        continue;
      }
      out[base] = sampleBilinear(image, source.x, source.y, 0);
      out[base + 1] = sampleBilinear(image, source.x, source.y, 1);
      out[base + 2] = sampleBilinear(image, source.x, source.y, 2);
    }
  }
  return out;
}

/** Convenience wrapper for the detector's full-frame letterbox. */
export function letterboxForDetector(
  image: RgbaImage,
  out?: Float32Array,
): Float32Array {
  return cropToNhwcFloat32(image, detectorRoi(image.width, image.height), DETECTOR_SIZE, out);
}

/** Convenience wrapper for one hand's landmark crop. */
export function cropForLandmarks(
  image: RgbaImage,
  roi: HandRoi,
  out?: Float32Array,
): Float32Array {
  return cropToNhwcFloat32(image, roi, LANDMARK_SIZE, out);
}

/**
 * Source pixels -> `brush` space: normalize, then mirror x.
 *
 * The model is fed the **un-mirrored** frame while the canvas shows a selfie
 * view, so exactly one mirror exists in the whole system and it is here. Doing
 * it in the preprocessing as well would cancel out and quietly swap the user's
 * hands back.
 */
export function sourceToBrush(point: Vec2, sourceWidth: number, sourceHeight: number): Vec2 {
  return { x: 1 - point.x / sourceWidth, y: point.y / sourceHeight };
}

/** Inverse of {@link sourceToBrush}; used to author fixtures backwards. */
export function brushToSource(point: Vec2, sourceWidth: number, sourceHeight: number): Vec2 {
  return { x: (1 - point.x) * sourceWidth, y: point.y * sourceHeight };
}
