import {
  ANCHOR_NUM_LAYERS,
  ANCHOR_OFFSET,
  ANCHOR_STRIDES,
  DETECTOR_SCORE_THRESHOLD,
  DETECTOR_SIZE,
  NMS_IOU_THRESHOLD,
  NUM_ANCHORS,
  NUM_COORDS,
  ROI_ROTATION_END_KEYPOINT,
  ROI_ROTATION_START_KEYPOINT,
  ROI_SCALE,
  ROI_SHIFT_Y,
  ROI_TARGET_ANGLE,
} from "./hand-model-contract";

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface PalmDetection {
  readonly score: number;
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly keypoints: readonly Vec2[];
}

export interface HandRoi {
  readonly cx: number;
  readonly cy: number;
  readonly size: number;
  readonly rotation: number;
}

interface Letterbox {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly size: number;
  readonly scale: number;
  readonly padX: number;
  readonly padY: number;
}

export function computeLetterbox(
  sourceWidth: number,
  sourceHeight: number
): Letterbox {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new Error(
      `Frame size must be positive, received ${sourceWidth}x${sourceHeight}.`
    );
  }
  const scale = DETECTOR_SIZE / Math.max(sourceWidth, sourceHeight);
  return {
    sourceWidth,
    sourceHeight,
    size: DETECTOR_SIZE,
    scale,
    padX: (DETECTOR_SIZE - sourceWidth * scale) / 2,
    padY: (DETECTOR_SIZE - sourceHeight * scale) / 2,
  };
}

export function ssdAnchors(): Float64Array {
  const centres: number[] = [];
  let layer = 0;
  while (layer < ANCHOR_NUM_LAYERS) {
    const stride = ANCHOR_STRIDES[layer]!;
    let last = layer;
    let perLocation = 0;
    while (last < ANCHOR_NUM_LAYERS && ANCHOR_STRIDES[last] === stride) {
      perLocation += 2;
      last++;
    }
    const cells = Math.ceil(DETECTOR_SIZE / stride);
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        for (let i = 0; i < perLocation; i++) {
          centres.push(
            (x + ANCHOR_OFFSET) / cells,
            (y + ANCHOR_OFFSET) / cells
          );
        }
      }
    }
    layer = last;
  }
  if (centres.length !== NUM_ANCHORS * 2) {
    throw new Error(
      `Anchor generation produced ${
        centres.length / 2
      } anchors, expected ${NUM_ANCHORS}.`
    );
  }
  return Float64Array.from(centres);
}

function detectorScore(logit: number): number {
  if (!Number.isFinite(logit)) return 0;
  const clamped = Math.min(100, Math.max(-100, logit));
  return 1 / (1 + Math.exp(-clamped));
}

export function decodeDetections(
  boxes: ArrayLike<number>,
  scores: ArrayLike<number>,
  anchors: ArrayLike<number>
): PalmDetection[] {
  const out: PalmDetection[] = [];
  for (let i = 0; i < NUM_ANCHORS; i++) {
    const score = detectorScore(scores[i] ?? 0);
    if (score < DETECTOR_SCORE_THRESHOLD) continue;
    const ax = anchors[i * 2] ?? 0;
    const ay = anchors[i * 2 + 1] ?? 0;
    const offset = i * NUM_COORDS;
    const cx = (boxes[offset] ?? 0) / DETECTOR_SIZE + ax;
    const cy = (boxes[offset + 1] ?? 0) / DETECTOR_SIZE + ay;
    const width = (boxes[offset + 2] ?? 0) / DETECTOR_SIZE;
    const height = (boxes[offset + 3] ?? 0) / DETECTOR_SIZE;
    const keypoints: Vec2[] = [];
    for (let point = 0; point < 7; point++) {
      keypoints.push({
        x: (boxes[offset + 4 + point * 2] ?? 0) / DETECTOR_SIZE + ax,
        y: (boxes[offset + 5 + point * 2] ?? 0) / DETECTOR_SIZE + ay,
      });
    }
    out.push({
      score,
      xmin: cx - width / 2,
      ymin: cy - height / 2,
      xmax: cx + width / 2,
      ymax: cy + height / 2,
      keypoints,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

const boxWidth = (detection: PalmDetection) => detection.xmax - detection.xmin;
const boxHeight = (detection: PalmDetection) => detection.ymax - detection.ymin;

function iou(a: PalmDetection, b: PalmDetection): number {
  const width = Math.max(
    0,
    Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin)
  );
  const height = Math.max(
    0,
    Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin)
  );
  const intersection = width * height;
  const union =
    boxWidth(a) * boxHeight(a) + boxWidth(b) * boxHeight(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

export function weightedNms(
  detections: readonly PalmDetection[],
  maxDetections = 2
): PalmDetection[] {
  let remaining = [...detections].sort((a, b) => b.score - a.score);
  const kept: PalmDetection[] = [];
  while (remaining.length && kept.length < maxDetections) {
    const best = remaining[0]!;
    const cluster = remaining.filter(
      (detection) => iou(best, detection) > NMS_IOU_THRESHOLD
    );
    remaining = remaining.filter(
      (detection) => iou(best, detection) <= NMS_IOU_THRESHOLD
    );
    const total = cluster.reduce((sum, detection) => sum + detection.score, 0);
    if (!(total > 0)) {
      kept.push(best);
      continue;
    }
    let xmin = 0;
    let ymin = 0;
    let xmax = 0;
    let ymax = 0;
    const keypoints = Array.from({ length: 7 }, () => ({ x: 0, y: 0 }));
    for (const detection of cluster) {
      const weight = detection.score / total;
      xmin += weight * detection.xmin;
      ymin += weight * detection.ymin;
      xmax += weight * detection.xmax;
      ymax += weight * detection.ymax;
      for (let point = 0; point < 7; point++) {
        keypoints[point]!.x += weight * (detection.keypoints[point]?.x ?? 0);
        keypoints[point]!.y += weight * (detection.keypoints[point]?.y ?? 0);
      }
    }
    kept.push({ score: best.score, xmin, ymin, xmax, ymax, keypoints });
  }
  return kept;
}

function normaliseAngle(angle: number): number {
  return angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
}

interface SquareRoi {
  readonly xCenter: number;
  readonly yCenter: number;
  readonly size: number;
  readonly rotation: number;
}

export function detectionToSquareRoi(detection: PalmDetection): SquareRoi {
  const start = detection.keypoints[ROI_ROTATION_START_KEYPOINT] ?? {
    x: 0,
    y: 0,
  };
  const end = detection.keypoints[ROI_ROTATION_END_KEYPOINT] ?? { x: 0, y: 0 };
  const rotation = normaliseAngle(
    ROI_TARGET_ANGLE - Math.atan2(-(end.y - start.y), end.x - start.x)
  );
  const width = boxWidth(detection);
  const height = boxHeight(detection);
  return {
    xCenter:
      (detection.xmin + detection.xmax) / 2 -
      height * ROI_SHIFT_Y * Math.sin(rotation),
    yCenter:
      (detection.ymin + detection.ymax) / 2 +
      height * ROI_SHIFT_Y * Math.cos(rotation),
    size: Math.max(width, height) * ROI_SCALE,
    rotation,
  };
}

export function roiToSource(roi: SquareRoi, letterbox: Letterbox): HandRoi {
  return {
    cx: (roi.xCenter * letterbox.size - letterbox.padX) / letterbox.scale,
    cy: (roi.yCenter * letterbox.size - letterbox.padY) / letterbox.scale,
    size: (roi.size * letterbox.size) / letterbox.scale,
    rotation: roi.rotation,
  };
}

export function isRoiSane(
  roi: HandRoi | undefined,
  sourceWidth: number,
  sourceHeight: number,
  minFraction: number,
  maxFraction: number
): boolean {
  if (!roi || !Number.isFinite(roi.cx) || !Number.isFinite(roi.cy))
    return false;
  if (!Number.isFinite(roi.size) || !Number.isFinite(roi.rotation))
    return false;
  const short = Math.min(sourceWidth, sourceHeight);
  if (!(short > 0)) return false;
  const fraction = roi.size / short;
  return fraction >= minFraction && fraction <= maxFraction;
}
