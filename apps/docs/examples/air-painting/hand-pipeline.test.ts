/**
 * The host calculators MediaPipe ships as graph config rather than as weights.
 *
 * These are the parts most likely to be subtly wrong, because every one of them
 * produces plausible-looking output when it is broken: an anchor grid with the
 * wrong stride still decodes boxes, a transposed box layout still tracks
 * *something*, and a dropped rotation term only shows up when a hand tilts. So
 * they are tested against invariants and exact round-trips rather than by eye.
 */
import { describe, expect, it } from 'vitest';
import {
  computeLetterbox,
  cropToSource,
  decodeDetections,
  detectionToSquareRoi,
  detectorScore,
  iou,
  isRoiSane,
  landmarksToRoi,
  landmarkToSource,
  mcpCentroid,
  normaliseAngle,
  PALM_KEYPOINT_COUNT,
  roiToSource,
  sourceToCrop,
  squareToSource,
  ssdAnchors,
  weightedNms,
  type HandRoi,
  type PalmDetection,
} from './hand-pipeline';
import {
  DETECTOR_SIZE,
  LANDMARK_SIZE,
  MCP_LANDMARKS,
  NUM_ANCHORS,
  NUM_COORDS,
  NUM_LANDMARKS,
  ROI_MAX_FRACTION,
  ROI_MIN_FRACTION,
  ROI_SCALE,
} from './hand-model-contract';
import { canonicalHandLandmarks, HAND_EVIDENCE } from './fixtures';

function detection(overrides: Partial<PalmDetection> = {}): PalmDetection {
  return {
    score: 0.9,
    xmin: 0.4,
    ymin: 0.4,
    xmax: 0.6,
    ymax: 0.6,
    keypoints: Array.from({ length: PALM_KEYPOINT_COUNT }, () => ({ x: 0.5, y: 0.5 })),
    ...overrides,
  };
}

describe('SSD anchors', () => {
  const anchors = ssdAnchors();

  it('produces exactly the 2016 anchors the detector head expects', () => {
    // The single most load-bearing number here: if the layer merge or the
    // strides are wrong this count changes, and every decoded box silently
    // shifts.
    expect(anchors.length).toBe(NUM_ANCHORS * 2);
  });

  it('splits 1152 stride-8 anchors and 864 stride-16 anchors', () => {
    // 24x24 grid x 2 per cell, then 12x12 x 6 per cell.
    expect(24 * 24 * 2).toBe(1152);
    expect(12 * 12 * 6).toBe(864);
    expect(1152 + 864).toBe(NUM_ANCHORS);
  });

  it('keeps every centre inside the unit square', () => {
    for (let i = 0; i < anchors.length; i++) {
      expect(anchors[i]).toBeGreaterThan(0);
      expect(anchors[i]).toBeLessThan(1);
    }
  });

  it('places the first anchor at half a cell, not at the origin', () => {
    // `anchor_offset` is 0.5; starting at 0 would bias every box up and left by
    // half a cell, which reads as a small constant tracking error.
    expect(anchors[0]).toBeCloseTo(0.5 / 24, 12);
    expect(anchors[1]).toBeCloseTo(0.5 / 24, 12);
  });

  it('is deterministic', () => {
    expect(Array.from(ssdAnchors())).toEqual(Array.from(anchors));
  });
});

describe('detector decode', () => {
  const anchors = ssdAnchors();

  it('clamps the logit before the sigmoid so a huge score cannot overflow', () => {
    expect(detectorScore(1e9, 100)).toBeCloseTo(1, 12);
    expect(detectorScore(-1e9, 100)).toBeCloseTo(0, 12);
    expect(detectorScore(0, 100)).toBeCloseTo(0.5, 12);
    expect(detectorScore(Number.NaN, 100)).toBe(0);
  });

  it('drops everything below the score threshold', () => {
    const boxes = new Float32Array(NUM_ANCHORS * NUM_COORDS);
    const scores = new Float32Array(NUM_ANCHORS).fill(-10);
    expect(decodeDetections(boxes, scores, anchors)).toHaveLength(0);
  });

  it('decodes a box as an offset from its anchor, in detector pixels', () => {
    const boxes = new Float32Array(NUM_ANCHORS * NUM_COORDS);
    const scores = new Float32Array(NUM_ANCHORS).fill(-10);
    const index = 5;
    scores[index] = 10;
    // 19.2 detector px = 0.1 of the square.
    boxes[index * NUM_COORDS] = 0;
    boxes[index * NUM_COORDS + 1] = 0;
    boxes[index * NUM_COORDS + 2] = 0.2 * DETECTOR_SIZE;
    boxes[index * NUM_COORDS + 3] = 0.2 * DETECTOR_SIZE;

    const [decoded] = decodeDetections(boxes, scores, anchors);
    expect(decoded).toBeDefined();
    const ax = anchors[index * 2]!;
    const ay = anchors[index * 2 + 1]!;
    // Float32Array in, so float32 epsilon is the floor on these comparisons.
    expect(decoded!.xmin).toBeCloseTo(ax - 0.1, 6);
    expect(decoded!.xmax).toBeCloseTo(ax + 0.1, 6);
    expect(decoded!.ymin).toBeCloseTo(ay - 0.1, 6);
    expect(decoded!.ymax).toBeCloseTo(ay + 0.1, 6);
    expect(decoded!.keypoints).toHaveLength(PALM_KEYPOINT_COUNT);
  });

  it('reads x,y,w,h and not y,x,h,w', () => {
    // `reverse_output_order: true` upstream. Getting this backwards produces
    // boxes that look fine on a square hand and track the wrong axis otherwise.
    const boxes = new Float32Array(NUM_ANCHORS * NUM_COORDS);
    const scores = new Float32Array(NUM_ANCHORS).fill(-10);
    scores[0] = 10;
    boxes[2] = 0.4 * DETECTOR_SIZE; // w
    boxes[3] = 0.1 * DETECTOR_SIZE; // h
    const [decoded] = decodeDetections(boxes, scores, anchors);
    expect(decoded!.xmax - decoded!.xmin).toBeCloseTo(0.4, 6);
    expect(decoded!.ymax - decoded!.ymin).toBeCloseTo(0.1, 6);
  });

  it('returns detections best-first', () => {
    const boxes = new Float32Array(NUM_ANCHORS * NUM_COORDS);
    const scores = new Float32Array(NUM_ANCHORS).fill(-10);
    scores[0] = 1;
    scores[1] = 5;
    scores[2] = 3;
    const decoded = decodeDetections(boxes, scores, anchors);
    expect(decoded.map((d) => d.score)).toEqual([...decoded.map((d) => d.score)].sort((a, b) => b - a));
  });
});

describe('weighted NMS', () => {
  it('computes IoU symmetrically and returns 0 for disjoint boxes', () => {
    const a = detection({ xmin: 0, ymin: 0, xmax: 0.2, ymax: 0.2 });
    const b = detection({ xmin: 0.8, ymin: 0.8, xmax: 1, ymax: 1 });
    expect(iou(a, b)).toBe(0);
    expect(iou(a, a)).toBeCloseTo(1, 12);
    expect(iou(a, b)).toBe(iou(b, a));
  });

  it('folds an overlapping cluster into one blended survivor', () => {
    const kept = weightedNms([
      detection({ score: 0.9, xmin: 0.4, xmax: 0.6 }),
      detection({ score: 0.6, xmin: 0.42, xmax: 0.62 }),
    ]);
    expect(kept).toHaveLength(1);
    // Blended, so it is neither input exactly, but between them.
    expect(kept[0]!.xmin).toBeGreaterThan(0.4);
    expect(kept[0]!.xmin).toBeLessThan(0.42);
    // The survivor keeps the leader's confidence, not the cluster mean.
    expect(kept[0]!.score).toBeCloseTo(0.9, 12);
  });

  it('keeps two hands that do not overlap', () => {
    const kept = weightedNms([
      detection({ score: 0.9, xmin: 0.05, ymin: 0.4, xmax: 0.25, ymax: 0.6 }),
      detection({ score: 0.8, xmin: 0.75, ymin: 0.4, xmax: 0.95, ymax: 0.6 }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it('never returns more than the requested maximum', () => {
    const many = Array.from({ length: 9 }, (_unused, i) =>
      detection({ score: 0.9 - i * 0.05, xmin: i * 0.1, xmax: i * 0.1 + 0.05 }),
    );
    expect(weightedNms(many, { maxDetections: 2 })).toHaveLength(2);
  });

  it('does not depend on the order the detector emitted its boxes', () => {
    const input = [
      detection({ score: 0.9, xmin: 0.05, xmax: 0.25 }),
      detection({ score: 0.8, xmin: 0.75, xmax: 0.95 }),
    ];
    const forward = weightedNms(input);
    const reversed = weightedNms([...input].reverse());
    expect(reversed.map((d) => d.xmin)).toEqual(forward.map((d) => d.xmin));
  });
});

describe('palm box to ROI', () => {
  it('wraps angles into [-pi, pi)', () => {
    expect(normaliseAngle(0)).toBeCloseTo(0, 12);
    expect(normaliseAngle(0.5)).toBeCloseTo(0.5, 12);
    // Both odd multiples land on the same representative, which is what makes
    // the wrap a function of the angle and not of how it was reached.
    expect(normaliseAngle(3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(normaliseAngle(-3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
    for (const a of [-10, -2, 0.3, 4, 12]) {
      const wrapped = normaliseAngle(a);
      expect(wrapped).toBeGreaterThanOrEqual(-Math.PI);
      expect(wrapped).toBeLessThan(Math.PI);
      expect(Math.cos(wrapped)).toBeCloseTo(Math.cos(a), 10);
      expect(Math.sin(wrapped)).toBeCloseTo(Math.sin(a), 10);
    }
  });

  it('grows the palm box so the crop contains the whole hand', () => {
    const roi = detectionToSquareRoi(detection({ xmin: 0.4, ymin: 0.4, xmax: 0.6, ymax: 0.6 }));
    expect(roi.size).toBeCloseTo(0.2 * ROI_SCALE, 10);
  });

  it('is upright when the hand axis already points up', () => {
    const keypoints = Array.from({ length: PALM_KEYPOINT_COUNT }, () => ({ x: 0.5, y: 0.5 }));
    keypoints[0] = { x: 0.5, y: 0.6 };
    keypoints[2] = { x: 0.5, y: 0.4 };
    expect(detectionToSquareRoi(detection({ keypoints })).rotation).toBeCloseTo(0, 10);
  });

  it('rotates a quarter turn when the hand points sideways', () => {
    const keypoints = Array.from({ length: PALM_KEYPOINT_COUNT }, () => ({ x: 0.5, y: 0.5 }));
    keypoints[0] = { x: 0.4, y: 0.5 };
    keypoints[2] = { x: 0.6, y: 0.5 };
    expect(Math.abs(detectionToSquareRoi(detection({ keypoints })).rotation)).toBeCloseTo(
      Math.PI / 2,
      10,
    );
  });
});

describe('letterbox and source mapping', () => {
  it('centres a 16:9 frame with vertical padding only', () => {
    const lb = computeLetterbox(640, 360);
    expect(lb.padX).toBeCloseTo(0, 12);
    expect(lb.padY).toBeGreaterThan(0);
    expect(lb.scale).toBeCloseTo(DETECTOR_SIZE / 640, 12);
  });

  it('centres a portrait frame with horizontal padding only', () => {
    const lb = computeLetterbox(360, 640);
    expect(lb.padY).toBeCloseTo(0, 12);
    expect(lb.padX).toBeGreaterThan(0);
  });

  it('never stretches the camera', () => {
    for (const [w, h] of [
      [640, 360],
      [1280, 720],
      [480, 640],
      [800, 800],
    ]) {
      const lb = computeLetterbox(w!, h!);
      // One uniform scale for both axes is the whole point of a letterbox.
      expect(lb.sourceWidth * lb.scale + 2 * lb.padX).toBeCloseTo(DETECTOR_SIZE, 8);
      expect(lb.sourceHeight * lb.scale + 2 * lb.padY).toBeCloseTo(DETECTOR_SIZE, 8);
    }
  });

  it('rejects a degenerate frame size', () => {
    expect(() => computeLetterbox(0, 360)).toThrow();
    expect(() => computeLetterbox(640, -1)).toThrow();
  });

  it('maps the square corners back to the frame corners', () => {
    const lb = computeLetterbox(640, 360);
    const topLeft = squareToSource({ x: lb.padX / DETECTOR_SIZE, y: lb.padY / DETECTOR_SIZE }, lb);
    expect(topLeft.x).toBeCloseTo(0, 8);
    expect(topLeft.y).toBeCloseTo(0, 8);
    const bottomRight = squareToSource(
      { x: 1 - lb.padX / DETECTOR_SIZE, y: 1 - lb.padY / DETECTOR_SIZE },
      lb,
    );
    expect(bottomRight.x).toBeCloseTo(640, 6);
    expect(bottomRight.y).toBeCloseTo(360, 6);
  });

  it('carries the ROI rotation through unchanged, because a letterbox is conformal', () => {
    const lb = computeLetterbox(640, 360);
    const roi = roiToSource({ xCenter: 0.5, yCenter: 0.5, size: 0.2, rotation: 0.7 }, lb);
    expect(roi.rotation).toBeCloseTo(0.7, 12);
    expect(roi.cx).toBeCloseTo(320, 6);
    expect(roi.cy).toBeCloseTo(180, 6);
  });
});

describe('crop transform', () => {
  const roi: HandRoi = { cx: 300, cy: 200, size: 120, rotation: 0.6 };

  it('maps the crop centre to the ROI centre under any rotation', () => {
    for (const rotation of [0, 0.3, -1.2, Math.PI / 2, 3]) {
      const point = cropToSource({ x: 0.5, y: 0.5 }, { ...roi, rotation });
      expect(point.x).toBeCloseTo(roi.cx, 10);
      expect(point.y).toBeCloseTo(roi.cy, 10);
    }
  });

  it('round-trips crop space through source space', () => {
    for (const point of [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.25, y: 0.75 },
      { x: 1, y: 1 },
    ]) {
      const back = sourceToCrop(cropToSource(point, roi), roi);
      expect(back.x).toBeCloseTo(point.x, 10);
      expect(back.y).toBeCloseTo(point.y, 10);
    }
  });

  it('keeps the crop square: both axes span the same distance', () => {
    const across = cropToSource({ x: 1, y: 0.5 }, roi);
    const down = cropToSource({ x: 0.5, y: 1 }, roi);
    const dx = Math.hypot(across.x - roi.cx, across.y - roi.cy);
    const dy = Math.hypot(down.x - roi.cx, down.y - roi.cy);
    expect(dx).toBeCloseTo(dy, 10);
    expect(dx).toBeCloseTo(roi.size / 2, 10);
  });

  it('actually rotates: a rotated ROI moves the corners', () => {
    const upright = cropToSource({ x: 0, y: 0 }, { ...roi, rotation: 0 });
    const turned = cropToSource({ x: 0, y: 0 }, { ...roi, rotation: 1 });
    expect(Math.hypot(upright.x - turned.x, upright.y - turned.y)).toBeGreaterThan(1);
  });
});

describe('landmark decode', () => {
  const roi: HandRoi = { cx: 300, cy: 200, size: 120, rotation: 0.4 };

  it('treats the raw output as crop pixels, not normalized units', () => {
    const raw = new Float32Array(NUM_LANDMARKS * 3);
    // Dead centre of the crop, expressed the way the graph expresses it.
    for (let i = 0; i < NUM_LANDMARKS; i++) {
      raw[i * 3] = LANDMARK_SIZE / 2;
      raw[i * 3 + 1] = LANDMARK_SIZE / 2;
    }
    const points = landmarkToSource(raw, roi, LANDMARK_SIZE);
    expect(points).toHaveLength(NUM_LANDMARKS);
    for (const point of points) {
      expect(point.x).toBeCloseTo(roi.cx, 8);
      expect(point.y).toBeCloseTo(roi.cy, 8);
    }
  });

  it('averages exactly the four MCP knuckles', () => {
    const points = Array.from({ length: NUM_LANDMARKS }, (_unused, i) => ({ x: i, y: -i }));
    const expectedX = MCP_LANDMARKS.reduce((sum, i) => sum + i, 0) / MCP_LANDMARKS.length;
    const centroid = mcpCentroid(points);
    expect(centroid.x).toBeCloseTo(expectedX, 12);
    expect(centroid.y).toBeCloseTo(-expectedX, 12);
  });

  it('is unmoved by fingertips curling, which is why it is not a fingertip', () => {
    const canonical = canonicalHandLandmarks();
    const curled = canonical.map((point, i) =>
      [4, 8, 12, 16, 20].includes(i) ? { x: point.x, y: point.y + 0.3 } : point,
    );
    const before = mcpCentroid(canonical);
    const after = mcpCentroid(curled);
    expect(after.x).toBeCloseTo(before.x, 12);
    expect(after.y).toBeCloseTo(before.y, 12);
  });
});

describe('tracking loopback', () => {
  it('bounds all 21 landmarks and squares the region off', () => {
    const points = [
      { x: 100, y: 100 },
      ...Array.from({ length: NUM_LANDMARKS - 2 }, () => ({ x: 120, y: 130 })),
      { x: 160, y: 200 },
    ];
    const roi = landmarksToRoi(points, 2);
    expect(roi.cx).toBeCloseTo(130, 10);
    expect(roi.cy).toBeCloseTo(150, 10);
    // max(width, height) = max(60, 100) = 100, grown by 2.
    expect(roi.size).toBeCloseTo(200, 10);
  });

  it('grows the region so a hand opening between frames does not clip out', () => {
    const points = Array.from({ length: NUM_LANDMARKS }, (_unused, i) => ({ x: i, y: i }));
    const tight = landmarksToRoi(points, 1);
    const grown = landmarksToRoi(points, 2);
    expect(grown.size).toBeCloseTo(tight.size * 2, 10);
  });

  it('takes its angle from wrist to middle-finger MCP', () => {
    const points = Array.from({ length: NUM_LANDMARKS }, () => ({ x: 100, y: 100 }));
    points[0] = { x: 100, y: 140 };
    points[9] = { x: 100, y: 60 };
    expect(landmarksToRoi(points).rotation).toBeCloseTo(0, 10);
  });

  it('survives a full round trip: crop -> source -> next ROI -> crop', () => {
    const roi: HandRoi = { cx: 300, cy: 200, size: 150, rotation: 0.35 };
    const canonical = canonicalHandLandmarks();
    const raw = new Float32Array(NUM_LANDMARKS * 3);
    for (let i = 0; i < NUM_LANDMARKS; i++) {
      raw[i * 3] = canonical[i]!.x * LANDMARK_SIZE;
      raw[i * 3 + 1] = canonical[i]!.y * LANDMARK_SIZE;
    }
    const points = landmarkToSource(raw, roi, LANDMARK_SIZE);
    const next = landmarksToRoi(points, 2);
    // The next ROI must still contain every landmark it was built from.
    for (const point of points) {
      const inCrop = sourceToCrop(point, next);
      expect(inCrop.x).toBeGreaterThanOrEqual(0);
      expect(inCrop.x).toBeLessThanOrEqual(1);
      expect(inCrop.y).toBeGreaterThanOrEqual(0);
      expect(inCrop.y).toBeLessThanOrEqual(1);
    }
  });
});

describe('ROI sanity gate', () => {
  const sane: HandRoi = { cx: 320, cy: 180, size: 120, rotation: 0.2 };

  it('accepts a plausible hand-sized region', () => {
    expect(isRoiSane(sane, 640, 360, ROI_MIN_FRACTION, ROI_MAX_FRACTION)).toBe(true);
  });

  it('rejects a diverged, absent or non-finite region', () => {
    expect(isRoiSane(undefined, 640, 360, ROI_MIN_FRACTION, ROI_MAX_FRACTION)).toBe(false);
    for (const bad of [
      { ...sane, size: 0.1 },
      { ...sane, size: 100_000 },
      { ...sane, cx: Number.NaN },
      { ...sane, rotation: Number.POSITIVE_INFINITY },
    ]) {
      expect(isRoiSane(bad, 640, 360, ROI_MIN_FRACTION, ROI_MAX_FRACTION)).toBe(false);
    }
  });
});

describe('recorded model evidence', () => {
  it('keeps presence well clear of the gating thresholds on real hands', () => {
    for (const sample of HAND_EVIDENCE) {
      expect(sample.hands.length).toBeGreaterThan(0);
      for (const hand of sample.hands) {
        expect(hand.presence).toBeGreaterThan(0.9);
        expect(hand.detectorScore).toBeGreaterThan(0.5);
      }
    }
  });

  it('spans a wide range of hand rotations', () => {
    const rotations = HAND_EVIDENCE.flatMap((s) => s.hands.map((h) => h.rotationDegrees));
    expect(Math.max(...rotations) - Math.min(...rotations)).toBeGreaterThan(90);
  });

  it('records two separated hands for the two-hand photograph', () => {
    const twoHands = HAND_EVIDENCE[0]!;
    expect(twoHands.hands).toHaveLength(2);
    const [a, b] = twoHands.hands;
    expect(Math.abs(a!.centroid[0] - b!.centroid[0])).toBeGreaterThan(200);
  });
});
