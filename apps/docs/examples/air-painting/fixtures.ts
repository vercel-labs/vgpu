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
 * 3. `syntheticKeypointFrames()` — a 24-sample synthetic wrist trajectory encoded
 *    as real `[1,1,17,3]` buffers. It drives the *production* wrist/paint/
 *    composite shaders deterministically.
 *
 * (3) is a **visual** fixture. It proves the shaders and the lifetime plumbing,
 * and it proves nothing whatsoever about ORT interop — only a real browser can,
 * and the example says so in its own copy.
 */
import {
  brushSpaceToKeypoint,
  computeFrameTransform,
  KEYPOINT_ELEMENTS,
  LEFT_WRIST_INDEX,
  RIGHT_WRIST_INDEX,
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
 * arm that the synthetic wrist trajectory follows, against a soft pool of light.
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

/**
 * The synthetic wrist path in `brush` space (mirrored, normalized frame).
 *
 * A ribbon "S" that stays clear of the letterbox padding by construction and
 * sweeps across the figure's raised arm, so the revealed region shows real
 * image content rather than backdrop.
 */
export function syntheticBrushPath(count = SYNTHETIC_FRAME_COUNT): readonly Vec2[] {
  const path: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    path.push({
      x: 0.28 + 0.46 * t,
      y: 0.5 + 0.26 * Math.sin(t * Math.PI * 1.9) * Math.cos(t * 1.1),
    });
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

/**
 * Encodes the synthetic path as real `[1,1,17,3]` float32 buffers.
 *
 * Every keypoint is populated so the layout is exercised end to end, but only
 * index 10 carries a confident value; the rest sit below the enter threshold,
 * which is what the shader must ignore.
 */
export function syntheticKeypointFrames(
  transform: FrameTransform = fixtureTransform(),
  count = SYNTHETIC_FRAME_COUNT,
): readonly Float32Array[] {
  const path = syntheticBrushPath(count);
  return path.map((point, index) => {
    const keypoints = new Float32Array(KEYPOINT_ELEMENTS);
    // Plausible low-confidence filler for the other 16 keypoints.
    for (let k = 0; k < KEYPOINT_ELEMENTS / 3; k++) {
      const base = k * 3;
      keypoints[base] = 0.35 + 0.02 * k;
      keypoints[base + 1] = 0.45 + 0.01 * k;
      keypoints[base + 2] = 0.12;
    }
    const left = LEFT_WRIST_INDEX * 3;
    keypoints[left + 2] = 0.18;

    const encoded = brushSpaceToKeypoint(point, transform);
    const base = RIGHT_WRIST_INDEX * 3;
    keypoints[base] = encoded.y;
    keypoints[base + 1] = encoded.x;
    keypoints[base + 2] = syntheticConfidence(index, count);
    return keypoints;
  });
}
