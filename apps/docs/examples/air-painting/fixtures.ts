/**
 * Deterministic fixtures for the air-painting example.
 *
 * Three separate things live here, and they make different claims:
 *
 * 1. `EVIDENCE_KEYPOINTS` — real `[y, x, score]` wrist values the committed model
 *    produced on real GPU hardware for two COCO val2017 photos. They pin the
 *    letterbox/unletterbox math against the model's actual output. The photos
 *    themselves are not redistributed; only these numbers are.
 * 2. `createFixtureFrame()` — a license-clean camera stand-in, rasterized in pure
 *    TypeScript so the Node thumbnail, the unit tests and the no-camera visual
 *    demo all see byte-identical pixels with no webcam, network or codec.
 * 3. `syntheticKeypointFrames()` — a 24-sample synthetic **two-handed** trajectory
 *    encoded as real `[1,1,17,3]` buffers, wrists and elbows both. It drives the
 *    *production* wrist/paint/composite shaders deterministically.
 *
 * (3) is a **visual** fixture. It proves the shaders and the lifetime plumbing,
 * and it proves nothing whatsoever about ORT interop — only a real browser can,
 * and the example says so in its own copy.
 */
import {
  BRUSH_LIMBS,
  brushSpaceToKeypoint,
  computeFrameTransform,
  HAND_EXTRAPOLATION,
  KEYPOINT_COUNT,
  KEYPOINT_ELEMENTS,
  type FrameTransform,
  type Vec2,
} from './pose-contract';

/** Canned frame size; 16:9 like a typical webcam crop, small enough to author in TS. */
export const FIXTURE_FRAME_WIDTH = 640;
export const FIXTURE_FRAME_HEIGHT = 360;
export const FIXTURE_FRAME_BYTES = FIXTURE_FRAME_WIDTH * FIXTURE_FRAME_HEIGHT * 4;

/** Transform the fixtures are authored against. */
export function fixtureTransform(): FrameTransform {
  return computeFrameTransform(FIXTURE_FRAME_WIDTH, FIXTURE_FRAME_HEIGHT);
}

/**
 * Right-wrist `[y, x, score]` the committed `movenet-lightning.onnx` produced on
 * the author's discrete GPU (ORT 1.27.0, WebGPU EP, `gpu-buffer` output) for two
 * COCO val2017 single-person photos. Left wrist is recorded too, to document
 * that index 9 and 10 are genuinely different points.
 *
 * See public/models/movenet/PROVENANCE.md for the full gate table.
 */
export interface EvidenceSample {
  readonly image: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** `[y, x, score]`, normalized to the 192x192 letterboxed input. */
  readonly rightWrist: readonly [number, number, number];
  readonly leftWrist: readonly [number, number, number];
}

export const EVIDENCE_KEYPOINTS: readonly EvidenceSample[] = [
  {
    image: 'COCO val2017 000000000785.jpg',
    sourceWidth: 640,
    sourceHeight: 425,
    rightWrist: [0.4549751579761505, 0.466286838054657, 0.506779670715332],
    leftWrist: [0.4403899013996124, 0.710444986820221, 0.28623420000076294],
  },
  {
    image: 'COCO val2017 000000397133.jpg',
    sourceWidth: 640,
    sourceHeight: 427,
    rightWrist: [0.45636311173439026, 0.6833707094197, 0.19550147652626038],
    leftWrist: [0.46639949083328247, 0.7544093728065491, 0.3228681981563568],
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

/** Pins `createFixtureFrame()`; regenerate deliberately, never casually. */
export const FIXTURE_FRAME_HASH = '4f6e2a49';

/** Number of synthetic results the thumbnail and the visual demo replay. */
export const SYNTHETIC_FRAME_COUNT = 24;
/** Fixed timestep the synthetic sequence is authored for. */
export const SYNTHETIC_DT = 1 / 30;
/** Synthetic forearm length in brush units; sets where the elbow sits behind the hand. */
export const SYNTHETIC_FOREARM = 0.18;

/**
 * The synthetic **hand** paths in `brush` space (mirrored, normalized frame),
 * one per limb, both sweeping at once.
 *
 * Two ribbons rather than one: the author paints with both hands, so the canned
 * demo and the thumbnail have to show both, or the feature is invisible to
 * anyone who cannot grant a camera. They travel in opposite directions and stay
 * in separate horizontal bands so they read as two independent strokes and not
 * as one thick line, and both stay clear of the letterbox padding by
 * construction.
 */
export function syntheticHandPath(
  limb: 'left' | 'right',
  count = SYNTHETIC_FRAME_COUNT,
): readonly Vec2[] {
  const path: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const wave = Math.sin(t * Math.PI * 1.6);
    // The bands are pushed apart and the wave flattened so the closest approach
    // still clears three brush radii. A palm-sized brush is 60 texels across, and
    // at the old spacing the two wipes merged into a single smear.
    path.push(
      limb === 'right'
        ? { x: 0.32 + 0.36 * t, y: 0.28 + 0.12 * wave }
        : { x: 0.68 - 0.36 * t, y: 0.78 - 0.12 * wave },
    );
  }
  return path;
}

/**
 * Confidence ramp for the synthetic sequence: it crosses the 0.45 enter
 * threshold on the second sample and then stays above the 0.30 stay threshold,
 * which exercises acquisition without exercising a dropout.
 */
export function syntheticConfidence(index: number, count = SYNTHETIC_FRAME_COUNT): number {
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

/**
 * Wrist and elbow, in brush space, that make `wrist.wgsl` extrapolate to exactly
 * `hand`.
 *
 * Authoring runs backwards on purpose. The visible thing is the hand, so the
 * hand is what the path describes; the elbow is then placed a forearm behind it
 * along the direction of travel and **clamped into frame**, and the wrist is
 * solved from both:
 *
 * ```
 * hand = wrist + k·(wrist − elbow)   =>   wrist = (hand + k·elbow) / (1 + k)
 * ```
 *
 * Because that wrist is a convex combination of two in-frame points it is always
 * in frame itself, so clamping the elbow can never push a fixture keypoint into
 * the letterbox padding — and the extrapolation still lands on the authored hand
 * exactly, which is what lets the tests assert equality rather than proximity.
 */
export function syntheticArm(
  hand: Vec2,
  direction: Vec2,
  factor = HAND_EXTRAPOLATION.factor,
  forearm = SYNTHETIC_FOREARM,
): { readonly wrist: Vec2; readonly elbow: Vec2 } {
  const elbow: Vec2 = {
    x: Math.min(1, Math.max(0, hand.x - direction.x * forearm)),
    y: Math.min(1, Math.max(0, hand.y - direction.y * forearm)),
  };
  return {
    wrist: {
      x: (hand.x + factor * elbow.x) / (1 + factor),
      y: (hand.y + factor * elbow.y) / (1 + factor),
    },
    elbow,
  };
}

/**
 * Encodes both synthetic hand paths as real `[1,1,17,3]` float32 buffers.
 *
 * Every keypoint is populated so the layout is exercised end to end. Both wrists
 * (9, 10) carry the confidence ramp and both elbows (7, 8) sit above the elbow
 * floor so the hand extrapolation runs for real; the remaining thirteen stay
 * below the enter threshold, which is what the shader must ignore.
 */
export function syntheticKeypointFrames(
  transform: FrameTransform = fixtureTransform(),
  count = SYNTHETIC_FRAME_COUNT,
): readonly Float32Array[] {
  const paths = {
    left: syntheticHandPath('left', count),
    right: syntheticHandPath('right', count),
  } as const;

  const frames: Float32Array[] = [];
  for (let index = 0; index < count; index++) {
    const keypoints = new Float32Array(KEYPOINT_ELEMENTS);
    // Plausible low-confidence filler for every keypoint the brush ignores.
    for (let k = 0; k < KEYPOINT_COUNT; k++) {
      const base = k * 3;
      keypoints[base] = 0.35 + 0.02 * k;
      keypoints[base + 1] = 0.45 + 0.01 * k;
      keypoints[base + 2] = 0.12;
    }

    for (const limb of BRUSH_LIMBS) {
      const path = paths[limb.name];
      const arm = syntheticArm(path[index]!, tangent(path, index));
      const wrist = brushSpaceToKeypoint(arm.wrist, transform);
      const elbow = brushSpaceToKeypoint(arm.elbow, transform);

      const wristBase = limb.wrist * 3;
      keypoints[wristBase] = wrist.y;
      keypoints[wristBase + 1] = wrist.x;
      keypoints[wristBase + 2] = syntheticConfidence(index, count);

      const elbowBase = limb.elbow * 3;
      keypoints[elbowBase] = elbow.y;
      keypoints[elbowBase + 1] = elbow.x;
      // Comfortably above HAND_EXTRAPOLATION.elbowConfidence: a real elbow is
      // usually easier for the model to see than the hand at the end of it.
      keypoints[elbowBase + 2] = 0.6;
    }
    frames.push(keypoints);
  }
  return frames;
}
