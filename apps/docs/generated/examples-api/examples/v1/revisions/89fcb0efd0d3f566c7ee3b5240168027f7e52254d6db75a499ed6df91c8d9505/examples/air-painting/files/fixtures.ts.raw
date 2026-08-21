/**
 * Deterministic fixtures for the air-painting example.
 *
 * Three separate things live here, and they make different claims:
 *
 * 1. `HAND_EVIDENCE` — real measurements the committed model pair produced on
 *    real photographs, recorded so the geometry has something to be checked
 *    against that is not itself synthetic. The photos are not redistributed by
 *    the example; only these numbers are.
 * 2. `createFixtureFrame()` — a license-clean camera stand-in, rasterized in pure
 *    TypeScript so the Node thumbnail, the unit tests and the no-camera visual
 *    demo all see byte-identical pixels with no webcam, network or codec.
 * 3. `syntheticHandFrames()` — a 24-sample synthetic **two-handed** trajectory
 *    encoded as real `[1,63]` landmark buffers plus the ROIs they were cropped
 *    through. It drives the *production* `hand.wgsl` / `paint.wgsl` /
 *    `composite.wgsl` deterministically.
 *
 * (3) is a **visual** fixture. It proves the shaders, the inverse crop transform
 * and the lifetime plumbing, and it proves nothing whatsoever about ORT interop
 * — only a real browser can, and the example says so in its own copy.
 *
 * The synthetic landmarks are authored **backwards**, which is what lets the
 * tests assert equality rather than proximity: a canonical hand is built with
 * its MCP centroid at the exact centre of the crop, and the ROI is then placed
 * with its centre on the point the path wants painted. Because the centre of a
 * crop maps to the centre of its ROI under any rotation, the measured centroid
 * lands on the authored point exactly, whatever angle the fixture uses.
 */
import { brushToSource } from './hand-preprocess';
import { LANDMARK_SIZE, MCP_LANDMARKS, NUM_LANDMARKS } from './hand-model-contract';
import { sourceToCrop, type HandRoi, type Vec2 } from './hand-pipeline';

/** Canned frame size; 16:9 like a typical webcam crop, small enough to author in TS. */
export const FIXTURE_FRAME_WIDTH = 640;
export const FIXTURE_FRAME_HEIGHT = 360;
export const FIXTURE_FRAME_BYTES = FIXTURE_FRAME_WIDTH * FIXTURE_FRAME_HEIGHT * 4;

/**
 * Measurements the committed `palm-detector.onnx` + `hand-landmark.onnx` pair
 * produced through the full host pipeline on two Creative-Commons photographs,
 * via the ONNX Runtime CPU execution provider.
 *
 * These are recorded for one reason: they are the only numbers in this file that
 * a bug in the geometry could not have produced, because they came out of the
 * real models on real hands. See tools/models/mediapipe-hands/image-credits.md
 * for the sources and licenses.
 *
 * The `presence` column is the interesting one. Two other candidate photographs
 * scored 0.578 and 0.583 at the **detector** and came back with presence 0.044
 * and 0.017 — confident-looking palms that the landmark model correctly refused
 * to vouch for. That gap is why confidence in this example is hand presence and
 * never a carried-over detector score.
 */
export interface HandEvidenceSample {
  readonly image: string;
  readonly hands: readonly {
    /** Palm detector confidence after weighted NMS. */
    readonly detectorScore: number;
    /** Landmark model hand presence. This is what gates the brush. */
    readonly presence: number;
    /** ROI rotation in degrees; the fixtures were chosen to span a wide range. */
    readonly rotationDegrees: number;
    /** MCP centroid in source pixels. */
    readonly centroid: readonly [number, number];
  }[];
}

export const HAND_EVIDENCE: readonly HandEvidenceSample[] = [
  {
    image: 'Open Hands Facing The Heavens (CC BY-SA 4.0), 960px rendition',
    hands: [
      { detectorScore: 0.866, presence: 0.99, rotationDegrees: 72.5, centroid: [862, 954] },
      { detectorScore: 0.735, presence: 0.995, rotationDegrees: -59.8, centroid: [136, 902] },
    ],
  },
  {
    image: 'Pride.be 2018 DSC08078 (CC BY-SA 2.0), 960px rendition',
    hands: [
      { detectorScore: 0.693, presence: 0.954, rotationDegrees: 87.8, centroid: [889, 1079] },
    ],
  },
];

/** Deterministic 32-bit hash, so "noise" is reproducible on every platform. */
function hash2(x: number, y: number): number {
  let h = (x * 374_761_393 + y * 668_265_263) | 0;
  h = (h ^ (h >>> 13)) * 1_274_126_177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4_294_967_295;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Rasterizes the canned "camera" frame as tightly packed RGBA8.
 *
 * Deliberately **not a person**. The example used to ship a synthetic figure and
 * it looked like exactly what it was, so the stand-in is now an abstract
 * composition chosen for one job: making the frost unmistakable.
 *
 * That job dictates the content. It is built from two frequency bands, because
 * blur is only legible if there is something at the scale the blur destroys:
 *
 * - Fine concentric rings, ~15 px per cycle, are the carrier. A gaussian with a
 *   sigma of a few quarter-resolution texels annihilates them completely, so the
 *   frosted state is smooth and the wiped state is visibly crisp.
 * - Three soft discs are the ballast. They are far wider than the blur kernel, so
 *   they survive it and the frosted state still reads as *something behind glass*
 *   rather than as a flat grey card.
 *
 * The ring wavelength is the one number here that is not free: at 15 px it is
 * ~15 samples per cycle, comfortably band-limited, so the sharp state shows clean
 * rings instead of the moire a tighter pattern would alias into.
 *
 * Neutral greyscale (r = g = b) and held in the mid range. The compositor lifts
 * the frost toward white, and a frame that already ran hot would clip to a flat
 * white sheet the moment it fogged.
 *
 * Coordinates here are **source** space (un-mirrored), exactly like a real
 * camera frame.
 */
export function createFixtureFrame(
  width = FIXTURE_FRAME_WIDTH,
  height = FIXTURE_FRAME_HEIGHT,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  // Disc radii are height-normalized, so x is scaled to keep them circular.
  const aspect = width / height;
  const ringCx = width * 0.5;
  const ringCy = height * 0.52;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;

      // Low band: three soft discs, wider than any blur kernel here, so the
      // frosted state keeps a sense of depth instead of going flat.
      let luma = 0.1;
      luma += 0.2 * disc(u, v, 0.34, 0.44, 0.26, aspect);
      luma += 0.26 * disc(u, v, 0.63, 0.6, 0.2, aspect);
      luma += 0.12 * disc(u, v, 0.79, 0.29, 0.13, aspect);

      // High band: concentric rings measured in real pixels, so the wavelength
      // is exact regardless of frame size. This is the detail the frost eats.
      const d = Math.hypot(x + 0.5 - ringCx, y + 0.5 - ringCy);
      luma += 0.085 * Math.sin((d / RING_WAVELENGTH_PX) * Math.PI * 2);

      // Just enough grain to break banding in the smooth discs.
      const value = clamp255((luma + (hash2(x, y) - 0.5) * 0.012) * 255);
      const index = (y * width + x) * 4;
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

/** Ring period in pixels. Well above the Nyquist limit, so the rings never alias. */
const RING_WAVELENGTH_PX = 15;

/**
 * Soft-edged disc with a height-normalized radius.
 *
 * `aspect` (width / height) scales x before measuring, so the disc is a real
 * circle in pixels rather than a 1.78x-wide ellipse on a 16:9 frame.
 */
function disc(
  x: number,
  y: number,
  cx: number,
  cy: number,
  radius: number,
  aspect: number,
): number {
  const d = Math.hypot((x - cx) * aspect, y - cy);
  return smoothstep(radius, radius * 0.35, d);
}

function clamp255(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** Cheap content hash so a change to the fixture frame has to be deliberate. */
export function hashBytes(bytes: Uint8Array): string {
  let hash = 2_166_136_261;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Pins `createFixtureFrame()`; regenerate deliberately, never casually.
 *
 * Unchanged by the hand swap: the fixture image is the *camera stand-in*, and
 * swapping the estimator does not change what a camera would have seen.
 */
export const FIXTURE_FRAME_HASH = '4f6e2a49';

/** Number of synthetic results the thumbnail and the visual demo replay. */
export const SYNTHETIC_FRAME_COUNT = 24;
/** Fixed timestep the synthetic sequence is authored for. */
export const SYNTHETIC_DT = 1 / 30;
/** Synthetic ROI side as a fraction of the frame's short edge. */
export const SYNTHETIC_ROI_FRACTION = 0.34;

/**
 * A plausible open right hand in **crop-normalized** coordinates, in MediaPipe's
 * landmark order: wrist, then thumb, index, middle, ring and pinky from base to
 * tip.
 *
 * Hand-authored rather than captured, because a fixture that came out of the
 * model could not be used to test the model's own geometry. What matters is only
 * that the proportions are sane: the MCP knuckles roughly in a row across the
 * middle, the wrist below them, the fingers fanning above.
 */
const RAW_HAND: readonly (readonly [number, number])[] = [
  [0.5, 0.88],
  [0.34, 0.78],
  [0.26, 0.68],
  [0.2, 0.6],
  [0.15, 0.53],
  [0.4, 0.5],
  [0.38, 0.38],
  [0.37, 0.3],
  [0.36, 0.23],
  [0.5, 0.48],
  [0.5, 0.35],
  [0.5, 0.26],
  [0.5, 0.19],
  [0.6, 0.5],
  [0.61, 0.37],
  [0.62, 0.29],
  [0.63, 0.22],
  [0.7, 0.54],
  [0.72, 0.44],
  [0.73, 0.37],
  [0.74, 0.31],
];

/**
 * {@link RAW_HAND} recentred so the mean of the four MCP knuckles is exactly the
 * centre of the crop.
 *
 * This is the trick the whole fixture rests on. The centre of a crop maps to the
 * centre of its ROI under any rotation and any scale, so once the canonical hand
 * is centred this way, placing the ROI at a point guarantees the measured MCP
 * centroid comes back at that same point — exactly, not approximately. The tests
 * can then assert the inverse transform to floating-point tolerance instead of
 * to some hand-waved pixel budget.
 */
export function canonicalHandLandmarks(): readonly Vec2[] {
  let cx = 0;
  let cy = 0;
  for (const index of MCP_LANDMARKS) {
    cx += RAW_HAND[index]![0];
    cy += RAW_HAND[index]![1];
  }
  cx /= MCP_LANDMARKS.length;
  cy /= MCP_LANDMARKS.length;
  return RAW_HAND.map(([x, y]) => ({ x: x - cx + 0.5, y: y - cy + 0.5 }));
}

/**
 * The synthetic hand paths in `brush` space (mirrored, normalized frame), one
 * per track slot, both sweeping at once.
 *
 * Two ribbons rather than one: the author paints with both hands, so the canned
 * demo and the thumbnail have to show both, or the feature is invisible to
 * anyone who cannot grant a camera. They travel in opposite directions and stay
 * in separate horizontal bands so they read as two independent strokes and not
 * as one thick line.
 */
export function syntheticHandPath(slot: number, count = SYNTHETIC_FRAME_COUNT): readonly Vec2[] {
  const path: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const wave = Math.sin(t * Math.PI * 1.6);
    // The bands are pushed apart and the wave flattened so the closest approach
    // still clears three brush radii. A palm-sized brush is 60 texels across, and
    // at tighter spacing the two wipes merge into a single smear.
    path.push(
      slot === 0
        ? { x: 0.32 + 0.36 * t, y: 0.28 + 0.12 * wave }
        : { x: 0.68 - 0.36 * t, y: 0.78 - 0.12 * wave },
    );
  }
  return path;
}

/**
 * Presence ramp for the synthetic sequence: it crosses the 0.45 enter threshold
 * on the first sample and then stays above the 0.30 stay threshold, which
 * exercises acquisition without exercising a dropout.
 */
export function syntheticPresence(index: number, count = SYNTHETIC_FRAME_COUNT): number {
  if (index === 0) return 0.52;
  const t = count === 1 ? 1 : index / (count - 1);
  return 0.55 + 0.2 * Math.sin(t * Math.PI);
}

/** Unit travel direction along a path, from neighbouring samples. */
function tangent(path: readonly Vec2[], index: number): Vec2 {
  const a = path[Math.max(0, index - 1)]!;
  const b = path[Math.min(path.length - 1, index + 1)]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 1e-6)) return { x: 1, y: 0 };
  return { x: dx / length, y: dy / length };
}

/** One slot's synthetic result: what the landmark model would have returned. */
export interface SyntheticHandResult {
  readonly slot: number;
  /** The ROI this crop was taken through, in source pixels. */
  readonly roi: HandRoi;
  /** `[1,63]` xyz in **crop pixels**, exactly as the graph emits them. */
  readonly landmarks: Float32Array;
  readonly presence: number;
  /** Where this result should land in `brush` space; the assertion target. */
  readonly expected: Vec2;
}

export interface SyntheticHandFrame {
  readonly results: readonly SyntheticHandResult[];
}

/**
 * Encodes both synthetic hand paths as real `[1,63]` landmark buffers plus the
 * ROIs they came from.
 *
 * The rotation is taken from the direction of travel, so the sequence sweeps
 * through a wide range of angles and a broken rotation term in the inverse
 * transform cannot pass unnoticed — an unrotated fixture would let a dropped
 * `sin` through, which is exactly the kind of bug that looks fine until a real
 * hand tilts.
 */
export function syntheticHandFrames(
  sourceWidth = FIXTURE_FRAME_WIDTH,
  sourceHeight = FIXTURE_FRAME_HEIGHT,
  count = SYNTHETIC_FRAME_COUNT,
): readonly SyntheticHandFrame[] {
  const canonical = canonicalHandLandmarks();
  const size = Math.min(sourceWidth, sourceHeight) * SYNTHETIC_ROI_FRACTION;
  const paths = [syntheticHandPath(0, count), syntheticHandPath(1, count)];
  const frames: SyntheticHandFrame[] = [];

  for (let index = 0; index < count; index++) {
    const results: SyntheticHandResult[] = [];
    for (let slot = 0; slot < paths.length; slot++) {
      const path = paths[slot]!;
      const expected = path[index]!;
      const centre = brushToSource(expected, sourceWidth, sourceHeight);
      const direction = tangent(path, index);
      // Mirrored back into source space, so the angle tracks the drawn stroke.
      const rotation = Math.atan2(direction.y, -direction.x);
      const roi: HandRoi = { cx: centre.x, cy: centre.y, size, rotation };

      const landmarks = new Float32Array(NUM_LANDMARKS * 3);
      for (let k = 0; k < NUM_LANDMARKS; k++) {
        const point = canonical[k]!;
        landmarks[k * 3] = point.x * LANDMARK_SIZE;
        landmarks[k * 3 + 1] = point.y * LANDMARK_SIZE;
        // z is emitted by the graph and ignored by this example; a plausible
        // non-zero value keeps the buffer honest about its real layout.
        landmarks[k * 3 + 2] = (point.y - 0.5) * 0.1 * LANDMARK_SIZE;
      }
      results.push({
        slot,
        roi,
        landmarks,
        presence: syntheticPresence(index, count),
        expected,
      });
    }
    frames.push({ results });
  }
  return frames;
}

/**
 * Packs an ROI into the four floats `hand-crop.wgsl` and `hand.wgsl` read.
 *
 * Layout is `vec2f center, f32 size, f32 rotation`, which is 16 bytes and needs
 * no padding.
 */
export function packRoi(roi: HandRoi, out = new Float32Array(4), offset = 0): Float32Array {
  out[offset] = roi.cx;
  out[offset + 1] = roi.cy;
  out[offset + 2] = roi.size;
  out[offset + 3] = roi.rotation;
  return out;
}

/**
 * Round-trips a synthetic result back to the point it was authored from.
 *
 * Used by the tests as an independent check that the fixture really is
 * self-consistent, rather than trusting the construction above.
 */
export function cropSpaceMcpCentroid(result: SyntheticHandResult): Vec2 {
  let x = 0;
  let y = 0;
  for (const index of MCP_LANDMARKS) {
    x += result.landmarks[index * 3]! / LANDMARK_SIZE;
    y += result.landmarks[index * 3 + 1]! / LANDMARK_SIZE;
  }
  return { x: x / MCP_LANDMARKS.length, y: y / MCP_LANDMARKS.length };
}

/** Inverse helper for tests: where a source point sits inside a result's crop. */
export function sourcePointInCrop(result: SyntheticHandResult, point: Vec2): Vec2 {
  return sourceToCrop(point, result.roi);
}
