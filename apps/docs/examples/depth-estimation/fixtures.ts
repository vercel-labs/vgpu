/**
 * Decoder for the committed depth fixture.
 *
 * The thumbnail has to draw a real depth field without running a model, so one
 * capture is committed: the default model's output on the committed source
 * image, quantized to unsigned 16-bit over a fixed metric range. 16 bits over
 * 16 m is a step of 0.24 mm, far below anything the relief shading can show,
 * and it stores the field in a quarter of the space raw floats would need.
 *
 * Imported by the thumbnail entry and the tests, never by the browser bundle.
 */
import {
  GOLDEN_DEPTH_BASE64,
  GOLDEN_HEIGHT,
  GOLDEN_SCALE_METERS,
  GOLDEN_WIDTH,
} from './golden-depth.generated';
import type { DepthModelId } from './model-contract';

export {
  GOLDEN_HEIGHT,
  GOLDEN_MODEL_SHA256,
  GOLDEN_SCALE_METERS,
  GOLDEN_SOURCE_SHA256,
  GOLDEN_STATS,
  GOLDEN_WIDTH,
} from './golden-depth.generated';

/** The fixture belongs to the default model; the picker's other two are lazy. */
export const GOLDEN_MODEL_ID: DepthModelId = 'fastdepth-320x256';

/** Same-origin URL of the image the fixture was captured from. */
export const GOLDEN_SOURCE_URL = '/examples/depth-estimation/source.jpg';

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  // Node (thumbnail rendering and tests).
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/**
 * Returns the fixture as metric depth in metres, row-major, ready to upload as
 * `array<f32>` exactly like a live model result.
 */
export function decodeGoldenDepth(): Float32Array {
  const bytes = decodeBase64(GOLDEN_DEPTH_BASE64);
  const expected = GOLDEN_WIDTH * GOLDEN_HEIGHT;
  if (bytes.byteLength !== expected * 2) {
    throw new Error(
      `golden depth fixture is ${bytes.byteLength} bytes, expected ${expected * 2}.`,
    );
  }
  // Copy into an aligned buffer: the base64 decode has no alignment guarantee.
  const aligned = new Uint16Array(expected);
  for (let i = 0; i < expected; i += 1) aligned[i] = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);

  const depth = new Float32Array(expected);
  const scale = GOLDEN_SCALE_METERS / 65535;
  for (let i = 0; i < expected; i += 1) depth[i] = aligned[i]! * scale;
  return depth;
}
