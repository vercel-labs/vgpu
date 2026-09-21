import { describe, expect, it } from "vitest";

import { NUM_ANCHORS, NUM_COORDS } from "./hand-model-contract";
import {
  computeLetterbox,
  decodeDetections,
  detectionToSquareRoi,
  isRoiSane,
  roiToSource,
  ssdAnchors,
  weightedNms,
  type PalmDetection,
} from "./hand-pipeline";

function detection(overrides: Partial<PalmDetection> = {}): PalmDetection {
  return {
    score: 0.9,
    xmin: 0.2,
    ymin: 0.2,
    xmax: 0.4,
    ymax: 0.4,
    keypoints: Array.from({ length: 7 }, (_, index) => ({
      x: index === 2 ? 0.3 : 0.25,
      y: index === 2 ? 0.2 : 0.35,
    })),
    ...overrides,
  };
}

describe("detector decode", () => {
  it("builds the frozen 2,016-anchor layout", () => {
    const anchors = ssdAnchors();
    expect(anchors).toHaveLength(NUM_ANCHORS * 2);
    expect([...anchors.slice(0, 4)]).toEqual([1 / 48, 1 / 48, 1 / 48, 1 / 48]);
  });

  it("decodes only finite logits above the confidence threshold", () => {
    const boxes = new Float32Array(NUM_ANCHORS * NUM_COORDS);
    const scores = new Float32Array(NUM_ANCHORS).fill(-100);
    boxes.set([0, 0, 96, 48], 0);
    scores[0] = 10;
    scores[1] = Number.NaN;
    const decoded = decodeDetections(boxes, scores, ssdAnchors());
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.xmax - decoded[0]!.xmin).toBeCloseTo(0.5);
    expect(decoded[0]!.ymax - decoded[0]!.ymin).toBeCloseTo(0.25);
  });

  it("merges overlapping palms with score-weighted coordinates", () => {
    const merged = weightedNms([
      detection({ score: 0.75, xmin: 0.1, xmax: 0.3 }),
      detection({ score: 0.25, xmin: 0.2, xmax: 0.4 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.score).toBe(0.75);
    expect(merged[0]!.xmin).toBeCloseTo(0.125);
    expect(merged[0]!.xmax).toBeCloseTo(0.325);
  });

  it("caps independent detections", () => {
    const palms = [
      detection({ xmin: 0, xmax: 0.1 }),
      detection({ xmin: 0.4, xmax: 0.5 }),
      detection({ xmin: 0.8, xmax: 0.9 }),
    ];
    expect(weightedNms(palms, 2)).toHaveLength(2);
  });
});

describe("crop geometry", () => {
  it("letterboxes landscape and portrait frames", () => {
    expect(computeLetterbox(640, 360)).toMatchObject({
      scale: 0.3,
      padX: 0,
      padY: 42,
    });
    expect(computeLetterbox(360, 640)).toMatchObject({
      scale: 0.3,
      padX: 42,
      padY: 0,
    });
  });

  it("rejects invalid frame dimensions", () => {
    expect(() => computeLetterbox(0, 360)).toThrow("must be positive");
  });

  it("turns a palm box into a rotated, expanded hand crop", () => {
    const roi = detectionToSquareRoi(detection());
    expect(roi.size).toBeCloseTo(0.52);
    expect(Number.isFinite(roi.rotation)).toBe(true);
  });

  it("undoes detector letterboxing in source pixels", () => {
    const source = roiToSource(
      { xCenter: 0.5, yCenter: 0.5, size: 0.25, rotation: 0.2 },
      computeLetterbox(640, 360)
    );
    expect(source).toEqual({ cx: 320, cy: 180, size: 160, rotation: 0.2 });
  });

  it("validates finite, proportionate tracking ROIs", () => {
    expect(
      isRoiSane({ cx: 10, cy: 20, size: 100, rotation: 0 }, 640, 360, 0.02, 2.5)
    ).toBe(true);
    expect(
      isRoiSane({ cx: 10, cy: 20, size: 1, rotation: 0 }, 640, 360, 0.02, 2.5)
    ).toBe(false);
    expect(
      isRoiSane(
        { cx: 10, cy: 20, size: 100, rotation: Number.NaN },
        640,
        360,
        0.02,
        2.5
      )
    ).toBe(false);
  });
});
