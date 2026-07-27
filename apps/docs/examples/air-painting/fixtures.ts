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
 * It is a synthetic figure, not a photograph: a key-lit head, torso and raised
 * arm, against a soft pool of light, that the synthetic hand paths sweep across.
 *
 * Deliberately **neutral greyscale** (r = g = b). The compositor's palette is two
 * docs greys, so a coloured frame would drag a third and fourth hue into an
 * otherwise monochrome design the moment a stroke revealed it.
 *
 * Tonally it is authored *for an ordered dither*: every value the figure and the
 * backdrop take lands in the mid-range, because a Bayer threshold turns tone into
 * dot *density* and only mid-tones have density to show. Pinning the body near
 * white — as an untuned figure does — reads as one flat blown-out mass with no
 * form at all. Fine per-pixel grain is intentional: it breaks up banding in the
 * dithered field and gives the revealed side real local variance.
 *
 * Coordinates here are **source** space (un-mirrored), exactly like a real
 * camera frame.
 */
export function createFixtureFrame(
  width = FIXTURE_FRAME_WIDTH,
  height = FIXTURE_FRAME_HEIGHT,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  // Capsule radii are height-normalized, so limbs keep a constant pixel thickness.
  const aspect = width / height;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const grain = hash2(x, y) - 0.5;

      // Backdrop: near-black negative space with a faint pool of light behind the
      // figure. Held far below the body's range on purpose — when the two ranges
      // overlap, the silhouette dissolves into the dot field and the whole frame
      // reads as one busy grey texture with no subject.
      const radial = Math.hypot((u - 0.54) / 0.6, (v - 0.46) / 0.8);
      let luma = 0.025 + 0.075 * smoothstep(1.15, 0.05, radial);

      // Head, neck, torso and the raised arm the wrist path sweeps along.
      const head = smoothstep(1.02, 0.9, Math.hypot((u - 0.55) / 0.058, (v - 0.3) / 0.092));
      const neck = capsule(u, v, 0.55, 0.38, 0.55, 0.54, 0.032, aspect);
      const torso = smoothstep(1.02, 0.86, Math.hypot((u - 0.56) / 0.17, (v - 0.88) / 0.36));
      const arm = capsule(u, v, 0.47, 0.6, 0.235, 0.335, 0.042, aspect);

      // Key light from the upper left, so the raised arm reaching toward it is the
      // brightest thing in frame. Every tone below is capped well short of white,
      // which would flatten into one blown-out mass with no form at all.
      const key = 0.6 * smoothstep(0.88, 0.16, u) + 0.26 * smoothstep(0.98, 0.22, v);

      // Composited in painter's order, each part carrying its own base tone rather
      // than being unioned into a single silhouette. The tonal step between parts
      // is what makes an overlap read as an edge in dot density: a flat union lit
      // by one shared ramp fuses head, shoulder and arm into an unreadable blob.
      // The neck is darkest — a contact shadow under the chin separates the head.
      luma = luma * (1 - torso) + torso * (0.26 + 0.3 * key);
      luma = luma * (1 - neck) + neck * (0.22 + 0.24 * key);
      luma = luma * (1 - head) + head * (0.38 + 0.34 * key);
      luma = luma * (1 - arm) + arm * (0.46 + 0.36 * key);

      // Grain stays tiny. Ordered dithering is a *geometric* pattern, and noise
      // injected before the threshold randomises which cells flip, turning clean
      // rows of dots into blue-noise mush. This is just enough to break banding.
      const value = clamp255((luma + grain * 0.012) * 255);
      const index = (y * width + x) * 4;
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

/**
 * Soft-edged capsule between two normalized points.
 *
 * `aspect` (width / height) scales x before measuring, so `radius` describes a
 * real circle in *pixels*. Without it a 16:9 frame stretches every capsule 1.78x
 * horizontally, and a diagonal limb rasterizes as a broad wedge instead of an arm.
 * `radius` is therefore in height-normalized units.
 */
function capsule(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
  aspect: number,
): number {
  const px = x * aspect;
  const abx = (bx - ax) * aspect;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby || 1;
  const t = Math.min(1, Math.max(0, ((px - ax * aspect) * abx + (y - ay) * aby) / lengthSq));
  const d = Math.hypot(px - (ax * aspect + abx * t), y - (ay + aby * t));
  return smoothstep(radius, radius * 0.6, d);
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
export const FIXTURE_FRAME_HASH = '2ebbb35c';

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
    path.push(
      limb === 'right'
        ? { x: 0.32 + 0.36 * t, y: 0.36 + 0.18 * wave }
        : { x: 0.68 - 0.36 * t, y: 0.7 - 0.18 * wave },
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
