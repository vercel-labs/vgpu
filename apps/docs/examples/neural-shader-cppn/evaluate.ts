/**
 * CPU evaluator for the committed CPPN weights.
 *
 * The browser runs the ONNX model on the GPU through ONNX Runtime Web. Node
 * thumbnail rendering has no browser ORT environment, so it evaluates the exact
 * same weights here and presents the result with the production shader. This is
 * visual validation only; the interop proof lives in the browser.
 *
 * `Math.fround` is applied at every affine and activation boundary so the CPU
 * result stays within float32 tolerance of the ORT result.
 */
import { B0, B1, B2, B3, GRID, LAYER_SIZES, PIXELS, W0, W1, W2, W3 } from './model-weights.generated';

/** Seconds are scaled before entering the network so the drift is gentle. */
export const TIME_SCALE = 0.35;
/** float32 RGBA, exactly one 256x256 image. */
export const RGBA_BYTES = PIXELS * 4 * 4;
export { GRID, PIXELS };

/**
 * Normalized coordinates in the model's input layout: `coords[2p]` is x and
 * `coords[2p + 1]` is y for pixel `p = y * GRID + x`, both pixel-centred and
 * mapped to [-1, 1).
 */
export function coordinateGrid(): Float32Array {
  const coords = new Float32Array(PIXELS * 2);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const p = y * GRID + x;
      coords[2 * p] = Math.fround(((x + 0.5) / GRID) * 2 - 1);
      coords[2 * p + 1] = Math.fround(((y + 0.5) / GRID) * 2 - 1);
    }
  }
  return coords;
}

/**
 * Byte view for `Buffer.write`. TypeScript 5.7 types `Float32Array` as
 * `Float32Array<ArrayBufferLike>`, which the vgpu write signature rejects.
 */
export function asWriteData(view: Float32Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
}

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/**
 * Evaluates the network for one time value and returns flat NHWC RGBA float32
 * values (`R, G, B, A` per pixel, `A` always 1), matching the model output.
 */
export function evaluateCppnImage(timeInput: number, coords = coordinateGrid()): Float32Array {
  const { l0, l1, l2, out } = LAYER_SIZES;
  const t = Math.fround(timeInput);
  const image = new Float32Array(PIXELS * 4);

  // Scratch buffers reused per pixel; h0/h1 are [sin, tanh] concatenations.
  const z0 = new Float32Array(l0);
  const h0 = new Float32Array(2 * l0);
  const z1 = new Float32Array(l1);
  const h1 = new Float32Array(2 * l1);
  const h2 = new Float32Array(l2);
  const z3 = new Float32Array(out);

  for (let p = 0; p < PIXELS; p++) {
    const x = coords[2 * p]!;
    const y = coords[2 * p + 1]!;

    for (let j = 0; j < l0; j++) {
      const sum = B0[j]! + x * W0[j]! + y * W0[l0 + j]! + t * W0[2 * l0 + j]!;
      z0[j] = Math.fround(sum);
    }
    for (let j = 0; j < l0; j++) {
      h0[j] = Math.fround(Math.sin(z0[j]!));
      h0[l0 + j] = Math.fround(Math.tanh(z0[j]!));
    }

    for (let j = 0; j < l1; j++) {
      let sum = B1[j]!;
      for (let i = 0; i < 2 * l0; i++) sum += h0[i]! * W1[i * l1 + j]!;
      z1[j] = Math.fround(sum);
    }
    for (let j = 0; j < l1; j++) {
      h1[j] = Math.fround(Math.sin(z1[j]!));
      h1[l1 + j] = Math.fround(Math.tanh(z1[j]!));
    }

    for (let j = 0; j < l2; j++) {
      let sum = B2[j]!;
      for (let i = 0; i < 2 * l1; i++) sum += h1[i]! * W2[i * l2 + j]!;
      h2[j] = Math.fround(Math.sin(Math.fround(sum)));
    }

    for (let j = 0; j < out; j++) {
      let sum = B3[j]!;
      for (let i = 0; i < l2; i++) sum += h2[i]! * W3[i * out + j]!;
      z3[j] = Math.fround(sum);
    }

    const base = p * 4;
    image[base] = Math.fround(sigmoid(z3[0]!));
    image[base + 1] = Math.fround(sigmoid(z3[1]!));
    image[base + 2] = Math.fround(sigmoid(z3[2]!));
    image[base + 3] = 1;
  }

  return image;
}
