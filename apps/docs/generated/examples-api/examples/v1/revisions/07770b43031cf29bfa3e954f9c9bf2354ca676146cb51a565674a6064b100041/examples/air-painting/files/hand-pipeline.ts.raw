/**
 * The half of MediaPipe's hand solution that is **not** in the ONNX files.
 *
 * The two converted graphs are a palm detector and a landmark reader. Between
 * them sit a stack of MediaPipe "calculators" that ship as graph configuration
 * rather than as weights, and every one of them has to be reimplemented here:
 * SSD anchor generation, sigmoid + threshold, weighted non-maximum suppression,
 * the palm-box-to-rotated-ROI transform, the crop geometry, the inverse
 * transform back to the frame, and the landmark-to-next-ROI loopback that lets
 * the detector be skipped.
 *
 * Pure TypeScript, no GPU/DOM/ORT: the same functions run in the browser, in the
 * ORT-free Node thumbnail and in the unit tests. The Python reference this was
 * ported from lives in `tools/models/mediapipe-hands/hand_pipeline.py` and the
 * two were checked against each other on real photographs before any of it was
 * allowed near the example.
 *
 * ## Coordinate spaces
 *
 * The detector sees a **letterboxed square**: the camera frame scaled to fit
 * 192x192 with black padding, so its outputs are normalized to that padded
 * square and mean nothing until the padding is divided back out. Everything the
 * detector produces therefore stays in `square` space until
 * {@link roiToSource} converts it, once, into **source pixels**.
 *
 * ROIs are held in source pixels rather than normalized units on purpose. An ROI
 * carries a rotation, and a rotation is only meaningful in a space with square
 * units; expressing it in normalized frame coordinates would shear the crop on
 * any non-square camera.
 */
import {
  ANCHOR_NUM_LAYERS,
  ANCHOR_OFFSET,
  ANCHOR_STRIDES,
  DETECTOR_SCORE_THRESHOLD,
  DETECTOR_SIZE,
  MCP_LANDMARKS,
  NMS_IOU_THRESHOLD,
  NUM_ANCHORS,
  NUM_COORDS,
  NUM_LANDMARKS,
  ROI_ROTATION_END_KEYPOINT,
  ROI_ROTATION_START_KEYPOINT,
  ROI_SCALE,
  ROI_SHIFT_Y,
  ROI_TARGET_ANGLE,
} from './hand-model-contract';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Palm keypoints the detector emits per anchor: wrist, MCPs and palm edges. */
export const PALM_KEYPOINT_COUNT = 7;

/** One decoded palm, in `square` space (letterboxed, normalized to [0,1]). */
export interface PalmDetection {
  readonly score: number;
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  /** {@link PALM_KEYPOINT_COUNT} palm points, also in `square` space. */
  readonly keypoints: readonly Vec2[];
}

/**
 * A rotated square region to crop for the landmark model.
 *
 * `cx`, `cy` and `size` are **source pixels**; `rotation` is radians, measured
 * so that applying it lifts the hand into the upright pose the landmark model
 * was trained on.
 */
export interface HandRoi {
  readonly cx: number;
  readonly cy: number;
  readonly size: number;
  readonly rotation: number;
}

/** Aspect-preserving fit of a frame into the detector's square. */
export interface Letterbox {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly size: number;
  /** Source pixels -> square pixels. */
  readonly scale: number;
  readonly padX: number;
  readonly padY: number;
}

export function computeLetterbox(
  sourceWidth: number,
  sourceHeight: number,
  size = DETECTOR_SIZE,
): Letterbox {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new Error(`Frame size must be positive, received ${sourceWidth}x${sourceHeight}.`);
  }
  const scale = size / Math.max(sourceWidth, sourceHeight);
  return {
    sourceWidth,
    sourceHeight,
    size,
    scale,
    padX: (size - sourceWidth * scale) / 2,
    padY: (size - sourceHeight * scale) / 2,
  };
}

// --- anchors ----------------------------------------------------------------

/**
 * The fixed SSD anchor centres, as a flat `[x0, y0, x1, y1, ...]`.
 *
 * `fixed_anchor_size: true` in the upstream options means every anchor is 1x1,
 * so only the centres are ever used and the widths are dropped. Layers that
 * share a stride merge into one grid: stride 8 contributes 2 anchors per cell
 * over a 24x24 grid (1,152) and the three stride-16 layers contribute 6 per cell
 * over 12x12 (864), which is exactly {@link NUM_ANCHORS}.
 */
export function ssdAnchors(size = DETECTOR_SIZE): Float64Array {
  const centres: number[] = [];
  let layer = 0;
  while (layer < ANCHOR_NUM_LAYERS) {
    const stride = ANCHOR_STRIDES[layer]!;
    let last = layer;
    let perLocation = 0;
    while (last < ANCHOR_NUM_LAYERS && ANCHOR_STRIDES[last] === stride) {
      // One anchor for aspect ratio 1.0 plus one for the interpolated scale.
      perLocation += 2;
      last += 1;
    }
    const cells = Math.ceil(size / stride);
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        for (let k = 0; k < perLocation; k++) {
          centres.push((x + ANCHOR_OFFSET) / cells, (y + ANCHOR_OFFSET) / cells);
        }
      }
    }
    layer = last;
  }
  if (centres.length !== NUM_ANCHORS * 2) {
    throw new Error(
      `Anchor generation produced ${centres.length / 2} anchors, expected ${NUM_ANCHORS}.`,
    );
  }
  return Float64Array.from(centres);
}

// --- detector decode --------------------------------------------------------

/** Logistic with the upstream logit clamp, so a huge logit cannot produce NaN. */
export function detectorScore(logit: number, clip: number): number {
  if (!Number.isFinite(logit)) return 0;
  const clamped = Math.min(clip, Math.max(-clip, logit));
  return 1 / (1 + Math.exp(-clamped));
}

/**
 * Decodes `Identity` `[1,2016,18]` and `Identity_1` `[1,2016,1]` against the
 * anchors, keeping anything above `scoreThreshold`, best first.
 *
 * The box terms are offsets **in detector pixels** relative to the anchor
 * centre, hence the division by the input size. `reverse_output_order: true`
 * upstream means the layout is `(x, y, w, h)` and not the `(y, x, h, w)` the
 * name "SSD" would suggest; getting that backwards yields boxes that look
 * plausible and track the wrong axis.
 */
export function decodeDetections(
  boxes: ArrayLike<number>,
  scores: ArrayLike<number>,
  anchors: ArrayLike<number>,
  options: { readonly scoreThreshold?: number; readonly scoreClip?: number; readonly size?: number } = {},
): PalmDetection[] {
  const scoreThreshold = options.scoreThreshold ?? DETECTOR_SCORE_THRESHOLD;
  const scoreClip = options.scoreClip ?? 100;
  const size = options.size ?? DETECTOR_SIZE;
  const out: PalmDetection[] = [];

  for (let i = 0; i < NUM_ANCHORS; i++) {
    const score = detectorScore(scores[i] ?? 0, scoreClip);
    if (!(score >= scoreThreshold)) continue;

    const ax = anchors[i * 2] ?? 0;
    const ay = anchors[i * 2 + 1] ?? 0;
    const b = i * NUM_COORDS;
    const cx = (boxes[b] ?? 0) / size + ax;
    const cy = (boxes[b + 1] ?? 0) / size + ay;
    const w = (boxes[b + 2] ?? 0) / size;
    const h = (boxes[b + 3] ?? 0) / size;

    const keypoints: Vec2[] = [];
    for (let k = 0; k < PALM_KEYPOINT_COUNT; k++) {
      keypoints.push({
        x: (boxes[b + 4 + 2 * k] ?? 0) / size + ax,
        y: (boxes[b + 5 + 2 * k] ?? 0) / size + ay,
      });
    }
    out.push({
      score,
      xmin: cx - w / 2,
      ymin: cy - h / 2,
      xmax: cx + w / 2,
      ymax: cy + h / 2,
      keypoints,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

const boxWidth = (d: PalmDetection) => d.xmax - d.xmin;
const boxHeight = (d: PalmDetection) => d.ymax - d.ymin;

export function iou(a: PalmDetection, b: PalmDetection): number {
  const ix = Math.max(0, Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin));
  const iy = Math.max(0, Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin));
  const intersection = ix * iy;
  const union = boxWidth(a) * boxHeight(a) + boxWidth(b) * boxHeight(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * MediaPipe's **weighted** NMS, which is not the usual "keep the best, drop the
 * rest".
 *
 * Each survivor is a score-weighted blend of every box it suppressed, so the
 * kept box is a consensus of its cluster rather than one arbitrary winner. That
 * materially steadies the ROI: plain NMS lets the crop jitter between frames as
 * the argmax anchor flips between neighbours, and the landmark model sees that
 * jitter as the hand moving.
 */
export function weightedNms(
  detections: readonly PalmDetection[],
  options: { readonly iouThreshold?: number; readonly maxDetections?: number } = {},
): PalmDetection[] {
  const iouThreshold = options.iouThreshold ?? NMS_IOU_THRESHOLD;
  const maxDetections = options.maxDetections ?? 2;

  let remaining = [...detections].sort((a, b) => b.score - a.score);
  const kept: PalmDetection[] = [];

  while (remaining.length > 0 && kept.length < maxDetections) {
    const best = remaining[0]!;
    const cluster = remaining.filter((d) => iou(best, d) > iouThreshold);
    const rest = remaining.filter((d) => iou(best, d) <= iouThreshold);
    const total = cluster.reduce((sum, d) => sum + d.score, 0);

    if (total > 0) {
      let xmin = 0;
      let ymin = 0;
      let xmax = 0;
      let ymax = 0;
      const keypoints = Array.from({ length: PALM_KEYPOINT_COUNT }, () => ({ x: 0, y: 0 }));
      for (const d of cluster) {
        const weight = d.score / total;
        xmin += weight * d.xmin;
        ymin += weight * d.ymin;
        xmax += weight * d.xmax;
        ymax += weight * d.ymax;
        for (let k = 0; k < PALM_KEYPOINT_COUNT; k++) {
          keypoints[k]!.x += weight * (d.keypoints[k]?.x ?? 0);
          keypoints[k]!.y += weight * (d.keypoints[k]?.y ?? 0);
        }
      }
      // The blended box keeps the cluster leader's score: it is the confidence
      // of the best evidence, not an average that a crowd of weak anchors could
      // inflate.
      kept.push({ score: best.score, xmin, ymin, xmax, ymax, keypoints });
    } else {
      kept.push(best);
    }
    remaining = rest;
  }
  return kept;
}

// --- ROI --------------------------------------------------------------------

/** Wraps an angle into [-pi, pi). */
export function normaliseAngle(angle: number): number {
  return angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
}

/** ROI in `square` space, before the letterbox is divided back out. */
export interface SquareRoi {
  readonly xCenter: number;
  readonly yCenter: number;
  readonly size: number;
  readonly rotation: number;
}

/**
 * `DetectionsToRectsCalculator` followed by `RectTransformationCalculator`.
 *
 * The hand's own axis is the vector from palm keypoint 0 (wrist centre) to
 * keypoint 2 (middle-finger MCP); the ROI is rotated so that axis points up.
 * The box is then grown by {@link ROI_SCALE} and slid along that rotated axis by
 * {@link ROI_SHIFT_Y}, which spends the extra room on the fingers instead of
 * centring it on the forearm.
 */
export function detectionToSquareRoi(detection: PalmDetection): SquareRoi {
  const start = detection.keypoints[ROI_ROTATION_START_KEYPOINT] ?? { x: 0, y: 0 };
  const end = detection.keypoints[ROI_ROTATION_END_KEYPOINT] ?? { x: 0, y: 0 };
  // Negated dy because image y grows downward while the target angle is measured
  // in the usual counter-clockwise convention.
  const rotation = normaliseAngle(ROI_TARGET_ANGLE - Math.atan2(-(end.y - start.y), end.x - start.x));
  const w = boxWidth(detection);
  const h = boxHeight(detection);
  // shift_x is 0 upstream, so only the shift_y terms survive.
  return {
    xCenter: (detection.xmin + detection.xmax) / 2 - h * ROI_SHIFT_Y * Math.sin(rotation),
    yCenter: (detection.ymin + detection.ymax) / 2 + h * ROI_SHIFT_Y * Math.cos(rotation),
    size: Math.max(w, h) * ROI_SCALE,
    rotation,
  };
}

/** `square` point -> source pixels, i.e. undo the padding then the scale. */
export function squareToSource(point: Vec2, letterbox: Letterbox): Vec2 {
  return {
    x: (point.x * letterbox.size - letterbox.padX) / letterbox.scale,
    y: (point.y * letterbox.size - letterbox.padY) / letterbox.scale,
  };
}

/**
 * `square` ROI -> source-pixel ROI.
 *
 * The letterbox is a uniform scale plus a translation, so it preserves angles
 * and the rotation carries over untouched; only the centre and the side length
 * have to be converted.
 */
export function roiToSource(roi: SquareRoi, letterbox: Letterbox): HandRoi {
  const centre = squareToSource({ x: roi.xCenter, y: roi.yCenter }, letterbox);
  return {
    cx: centre.x,
    cy: centre.y,
    size: (roi.size * letterbox.size) / letterbox.scale,
    rotation: roi.rotation,
  };
}

/**
 * Crop-normalized `[0,1]^2` -> source pixels.
 *
 * This is the exact transform `hand-crop.wgsl` implements, kept here so the
 * shader can be tested against a reference rather than by eye.
 */
export function cropToSource(point: Vec2, roi: HandRoi): Vec2 {
  const c = Math.cos(roi.rotation);
  const s = Math.sin(roi.rotation);
  const dx = (point.x - 0.5) * roi.size;
  const dy = (point.y - 0.5) * roi.size;
  return { x: roi.cx + dx * c - dy * s, y: roi.cy + dx * s + dy * c };
}

/** Inverse of {@link cropToSource}; used to author fixtures backwards. */
export function sourceToCrop(point: Vec2, roi: HandRoi): Vec2 {
  const c = Math.cos(roi.rotation);
  const s = Math.sin(roi.rotation);
  const dx = point.x - roi.cx;
  const dy = point.y - roi.cy;
  const size = roi.size === 0 ? 1e-6 : roi.size;
  return { x: (dx * c + dy * s) / size + 0.5, y: (-dx * s + dy * c) / size + 0.5 };
}

// --- landmark decode --------------------------------------------------------

/**
 * `Identity` `[1,63]` is in **crop pixels**, not normalized units.
 *
 * That is worth stating loudly because a `[1,63]` float output that happens to
 * fall in `[0,224]` looks exactly like a normalized output multiplied by
 * something, and dividing by the wrong constant produces landmarks that are
 * merely slightly wrong rather than obviously broken.
 */
export function landmarkToSource(
  raw: ArrayLike<number>,
  roi: HandRoi,
  cropSize: number,
): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const x = (raw[i * 3] ?? 0) / cropSize;
    const y = (raw[i * 3 + 1] ?? 0) / cropSize;
    points.push(cropToSource({ x, y }, roi));
  }
  return points;
}

/** Mean of the four MCP knuckles; see the note on {@link MCP_LANDMARKS}. */
export function mcpCentroid(points: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const index of MCP_LANDMARKS) {
    x += points[index]?.x ?? 0;
    y += points[index]?.y ?? 0;
  }
  return { x: x / MCP_LANDMARKS.length, y: y / MCP_LANDMARKS.length };
}

/**
 * The tracking loopback: next frame's ROI, straight from this frame's landmarks.
 *
 * This is what makes the detector skippable. The hand's axis is taken from
 * landmark 0 (wrist) to landmark 9 (middle-finger MCP) — the landmark model's
 * equivalent of the palm keypoints the detector used — and the ROI is the
 * axis-aligned bounding box of all 21 points, squared off and grown.
 *
 * Production runs this on the GPU inside `hand.wgsl`, because running it here
 * would mean reading the landmarks back to the CPU every single frame and the
 * whole point of the output path is that they never leave the device. This
 * implementation is the reference the shader is tested against.
 */
export function landmarksToRoi(points: readonly Vec2[], scale = 2): HandRoi {
  const start = points[0] ?? { x: 0, y: 0 };
  const end = points[9] ?? { x: 0, y: 0 };
  const rotation = normaliseAngle(ROI_TARGET_ANGLE - Math.atan2(-(end.y - start.y), end.x - start.x));
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  for (const point of points) {
    if (point.x < xmin) xmin = point.x;
    if (point.y < ymin) ymin = point.y;
    if (point.x > xmax) xmax = point.x;
    if (point.y > ymax) ymax = point.y;
  }
  return {
    cx: (xmin + xmax) / 2,
    cy: (ymin + ymax) / 2,
    size: Math.max(xmax - xmin, ymax - ymin) * scale,
    rotation,
  };
}

/** True when an ROI is finite and its side is a plausible fraction of the frame. */
export function isRoiSane(
  roi: HandRoi | undefined,
  sourceWidth: number,
  sourceHeight: number,
  minFraction: number,
  maxFraction: number,
): boolean {
  if (!roi) return false;
  if (!Number.isFinite(roi.cx) || !Number.isFinite(roi.cy)) return false;
  if (!Number.isFinite(roi.size) || !Number.isFinite(roi.rotation)) return false;
  const short = Math.min(sourceWidth, sourceHeight);
  if (!(short > 0)) return false;
  const fraction = roi.size / short;
  return fraction >= minFraction && fraction <= maxFraction;
}
