import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_KEYPOINTS,
  fixtureTransform,
  FIXTURE_FRAME_HEIGHT,
  FIXTURE_FRAME_WIDTH,
  SYNTHETIC_DT,
  SYNTHETIC_FRAME_COUNT,
  syntheticHandPath,
  syntheticKeypointFrames,
} from './fixtures';
import {
  applyPoseSample,
  bayer8,
  brushSpaceToKeypoint,
  BRUSH_BUFFER_BYTES,
  BRUSH_COUNT,
  BRUSH_LIMBS,
  BRUSH_STATE_BYTES,
  BRUSH_STATE_SLOTS,
  BRUSH_TUNING,
  computeFrameTransform,
  createBrushSnapshot,
  extrapolateHand,
  HAND_EXTRAPOLATION,
  handFromSample,
  keypointToBrushSpace,
  KEYPOINT_COUNT,
  LEFT_ELBOW_INDEX,
  LEFT_WRIST_INDEX,
  poseSampleFromKeypoints,
  RIGHT_ELBOW_INDEX,
  KEYPOINT_BYTES,
  KEYPOINT_ELEMENTS,
  MASK_BYTES,
  MASK_HEIGHT,
  MASK_WIDTH,
  MAX_SMOOTHING_DT,
  maxJumpDistance,
  MODEL_BYTES,
  MODEL_INPUT_ELEMENTS,
  MODEL_INPUT_SIZE,
  MODEL_SHA256,
  RIGHT_WRIST_INDEX,
  smoothingAlpha,
  KEYPOINT_NAMES,
} from './pose-contract';

describe('frozen model contract', () => {
  it('pins the committed model identity', () => {
    expect(MODEL_BYTES).toBe(9_402_989);
    expect(MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
    // Below the plan's 16 MiB review cap.
    expect(MODEL_BYTES).toBeLessThan(16 * 1024 * 1024);
  });

  it('describes a uint8 192x192x3 input and a [1,1,17,3] output', () => {
    expect(MODEL_INPUT_SIZE).toBe(192);
    expect(MODEL_INPUT_ELEMENTS).toBe(110_592);
    expect(KEYPOINT_ELEMENTS).toBe(51);
    expect(KEYPOINT_BYTES).toBe(204);
  });

  it('names the COCO keypoints with the wrists where MoveNet puts them', () => {
    expect(KEYPOINT_NAMES).toHaveLength(17);
    expect(KEYPOINT_NAMES[9]).toBe('left-wrist');
    expect(KEYPOINT_NAMES[RIGHT_WRIST_INDEX]).toBe('right-wrist');
  });

  it('bounds the persistent mask', () => {
    expect(MASK_WIDTH * MASK_HEIGHT * 4).toBe(MASK_BYTES);
    expect(MASK_BYTES).toBe(2_073_600);
  });
});

describe('letterbox transform', () => {
  it('centres a 16:9 frame with vertical padding only', () => {
    const transform = computeFrameTransform(640, 360);
    expect(transform.scale).toBeCloseTo(0.3, 10);
    expect(transform.drawWidth).toBeCloseTo(192, 10);
    expect(transform.drawHeight).toBeCloseTo(108, 10);
    expect(transform.padX).toBeCloseTo(0, 10);
    expect(transform.padY).toBeCloseTo(42, 10);
  });

  it('centres a portrait frame with horizontal padding only', () => {
    const transform = computeFrameTransform(480, 640);
    expect(transform.padY).toBeCloseTo(0, 10);
    expect(transform.padX).toBeCloseTo((192 - 144) / 2, 10);
  });

  it('never stretches the camera', () => {
    for (const [w, h] of [
      [1280, 720],
      [640, 480],
      [1920, 1080],
      [360, 640],
    ] as const) {
      const t = computeFrameTransform(w, h);
      expect(t.drawWidth / t.drawHeight).toBeCloseTo(w / h, 8);
    }
  });

  it('rejects a degenerate frame size', () => {
    expect(() => computeFrameTransform(0, 360)).toThrow(/positive/);
  });

  it('round-trips brush space through model space', () => {
    const transform = computeFrameTransform(1280, 720);
    for (const point of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.5, y: 0.5 },
      { x: 0.23, y: 0.81 },
    ]) {
      const keypoint = brushSpaceToKeypoint(point, transform);
      const back = keypointToBrushSpace(keypoint.y, keypoint.x, transform);
      expect(back).toBeDefined();
      expect(back!.x).toBeCloseTo(point.x, 6);
      expect(back!.y).toBeCloseTo(point.y, 6);
    }
  });

  it('maps the four corners of a 16:9 frame to the corners of brush space, mirrored', () => {
    const transform = computeFrameTransform(640, 360);
    // Top-left of the source frame is the top-RIGHT of the mirrored view.
    const topLeft = keypointToBrushSpace(42 / 192, 0, transform);
    expect(topLeft).toEqual({ x: 1, y: 0 });
    const bottomRight = keypointToBrushSpace(150 / 192, 1, transform);
    expect(bottomRight!.x).toBeCloseTo(0, 10);
    expect(bottomRight!.y).toBeCloseTo(1, 10);
  });

  it('rejects keypoints that land in the letterbox padding', () => {
    const transform = computeFrameTransform(640, 360);
    // y above the padded content area.
    expect(keypointToBrushSpace(10 / 192, 0.5, transform)).toBeUndefined();
    expect(keypointToBrushSpace(185 / 192, 0.5, transform)).toBeUndefined();
    // Inside the content area is fine.
    expect(keypointToBrushSpace(96 / 192, 0.5, transform)).toBeDefined();
  });

  it('places the real GPU evidence wrists inside the frame', () => {
    for (const sample of EVIDENCE_KEYPOINTS) {
      const transform = computeFrameTransform(sample.sourceWidth, sample.sourceHeight);
      const [y, x, score] = sample.rightWrist;
      const point = keypointToBrushSpace(y, x, transform);
      expect(point, `${sample.image} right wrist should unletterbox`).toBeDefined();
      expect(point!.x).toBeGreaterThanOrEqual(0);
      expect(point!.x).toBeLessThanOrEqual(1);
      expect(point!.y).toBeGreaterThanOrEqual(0);
      expect(point!.y).toBeLessThanOrEqual(1);
      expect(score).toBeGreaterThan(0);
      // Index 9 and 10 are genuinely different points, not a duplicated value.
      expect(sample.leftWrist[1]).not.toBeCloseTo(sample.rightWrist[1], 4);
    }
  });
});

describe('EMA smoothing', () => {
  it('matches the shader expression and is monotonic in dt', () => {
    expect(smoothingAlpha(0)).toBe(0);
    expect(smoothingAlpha(BRUSH_TUNING.emaTauSeconds)).toBeCloseTo(1 - Math.exp(-1), 10);
    expect(smoothingAlpha(1 / 60)).toBeLessThan(smoothingAlpha(1 / 30));
  });

  it('clamps a backgrounded-tab dt so the brush cannot teleport', () => {
    expect(smoothingAlpha(5)).toBe(smoothingAlpha(MAX_SMOOTHING_DT));
    expect(smoothingAlpha(-1)).toBe(0);
  });
});

describe('wrist state machine', () => {
  const transform = computeFrameTransform(640, 360);
  const at = (x: number, y: number, score: number) => {
    const k = brushSpaceToKeypoint({ x, y }, transform);
    return { y: k.y, x: k.x, score };
  };

  it('needs the enter threshold to acquire and paints nothing on acquisition', () => {
    const state = createBrushSnapshot();
    applyPoseSample(state, at(0.5, 0.5, 0.44), transform, 1 / 30);
    expect(state.active).toBe(false);
    expect(state.stroke).toBe(false);

    applyPoseSample(state, at(0.5, 0.5, 0.46), transform, 1 / 30);
    expect(state.active).toBe(true);
    // Acquisition seeds continuity but must not draw a capsule.
    expect(state.stroke).toBe(false);
    expect(state.prev).toEqual(state.current);
  });

  it('paints a segment once continuity exists', () => {
    const state = createBrushSnapshot();
    applyPoseSample(state, at(0.4, 0.5, 0.6), transform, 1 / 30);
    applyPoseSample(state, at(0.45, 0.5, 0.6), transform, 1 / 30);
    expect(state.stroke).toBe(true);
    expect(state.strokes).toBe(1);
    expect(state.prev.x).toBeCloseTo(0.4, 6);
    // EMA lags the measurement, so current sits between the two samples.
    expect(state.current.x).toBeGreaterThan(0.4);
    expect(state.current.x).toBeLessThan(0.45);
  });

  it('keeps painting between the stay and enter thresholds (hysteresis)', () => {
    const state = createBrushSnapshot();
    applyPoseSample(state, at(0.4, 0.5, 0.6), transform, 1 / 30);
    applyPoseSample(state, at(0.42, 0.5, 0.35), transform, 1 / 30);
    expect(state.active).toBe(true);
    expect(state.stroke).toBe(true);
  });

  it('drops the pose after two invalid results and never draws a connector', () => {
    const state = createBrushSnapshot();
    applyPoseSample(state, at(0.4, 0.5, 0.6), transform, 1 / 30);
    applyPoseSample(state, at(0.42, 0.5, 0.6), transform, 1 / 30);

    applyPoseSample(state, at(0.42, 0.5, 0.1), transform, 1 / 30);
    expect(state.invalid).toBe(1);
    expect(state.active).toBe(true);
    expect(state.stroke).toBe(false);

    applyPoseSample(state, at(0.42, 0.5, 0.1), transform, 1 / 30);
    expect(state.invalid).toBe(2);
    expect(state.active).toBe(false);
    expect(state.hasPrev).toBe(false);

    // Reacquisition on the far side of the frame draws nothing.
    applyPoseSample(state, at(0.9, 0.9, 0.9), transform, 1 / 30);
    expect(state.active).toBe(true);
    expect(state.stroke).toBe(false);
    expect(state.prev).toEqual(state.current);
  });

  it('rejects a keypoint inside the letterbox padding as invalid', () => {
    const state = createBrushSnapshot();
    applyPoseSample(state, { y: 0.02, x: 0.5, score: 0.9 }, transform, 1 / 30);
    expect(state.active).toBe(false);
    expect(state.invalid).toBe(1);
  });

  it('rejects NaN and out-of-range keypoints', () => {
    const state = createBrushSnapshot();
    applyPoseSample(state, { y: Number.NaN, x: 0.5, score: 0.9 }, transform, 1 / 30);
    expect(state.active).toBe(false);
    applyPoseSample(state, { y: 0.5, x: 1.4, score: 0.9 }, transform, 1 / 30);
    expect(state.active).toBe(false);
    expect(state.invalid).toBe(2);
  });

  it('breaks the line on an implausible jump instead of drawing across the frame', () => {
    const state = createBrushSnapshot();
    // Establish a stroke with a large dt so alpha is near 1 and the jump lands.
    applyPoseSample(state, at(0.1, 0.5, 0.9), transform, 1);
    applyPoseSample(state, at(0.12, 0.5, 0.9), transform, 1);
    expect(state.stroke).toBe(true);

    applyPoseSample(state, at(0.95, 0.95, 0.9), transform, 1);
    expect(state.stroke).toBe(false);
    expect(state.hasPrev).toBe(false);
    // Tracking continues at the new position.
    expect(state.current.x).toBeCloseTo(0.95, 5);
  });

  it('accepts a step just under the jump cap', () => {
    const state = createBrushSnapshot();
    const cap = maxJumpDistance();
    expect(cap).toBeCloseTo(0.18 * Math.SQRT2, 10);
    applyPoseSample(state, at(0.3, 0.5, 0.9), transform, 1);
    applyPoseSample(state, at(0.3 + cap * 0.9, 0.5, 0.9), transform, 1);
    expect(state.stroke).toBe(true);
  });

  it('reset drops continuity without losing the tracked position', () => {
    const state = createBrushSnapshot();
    applyPoseSample(state, at(0.4, 0.5, 0.9), transform, 1 / 30);
    applyPoseSample(state, at(0.42, 0.5, 0.9), transform, 1 / 30);
    const before = { ...state.current };

    applyPoseSample(state, at(0.44, 0.5, 0.9), transform, 1 / 30, { reset: true });
    expect(state.stroke).toBe(false);
    expect(state.active).toBe(true);
    expect(state.current.x).not.toBeCloseTo(before.x, 10);

    // The next result resumes painting from the post-clear position.
    applyPoseSample(state, at(0.46, 0.5, 0.9), transform, 1 / 30);
    expect(state.stroke).toBe(true);
  });
});

describe('Bayer 8x8 matrix', () => {
  // The standard recursive Bayer matrix; the shader builds this with bit tricks.
  const expected = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ];

  it('reproduces the literal matrix', () => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(bayer8(x, y), `cell (${x}, ${y})`).toBe(expected[y]![x]!);
      }
    }
  });

  it('is a permutation of 0..63 and tiles', () => {
    const seen = new Set<number>();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) seen.add(bayer8(x, y));
    expect(seen.size).toBe(64);
    expect(bayer8(9, 17)).toBe(bayer8(1, 1));
  });
});

describe('synthetic fixtures', () => {
  const transform = fixtureTransform();

  it('is authored against the canned frame size', () => {
    expect(transform.sourceWidth).toBe(FIXTURE_FRAME_WIDTH);
    expect(transform.sourceHeight).toBe(FIXTURE_FRAME_HEIGHT);
  });

  it('keeps both hand paths inside the frame, never in the padding', () => {
    for (const limb of ['left', 'right'] as const) {
      for (const point of syntheticHandPath(limb)) {
        expect(point.x, limb).toBeGreaterThan(0);
        expect(point.x, limb).toBeLessThan(1);
        expect(point.y, limb).toBeGreaterThan(0);
        expect(point.y, limb).toBeLessThan(1);
      }
    }
  });

  it('separates the two paths so they read as two strokes, not one', () => {
    const left = syntheticHandPath('left');
    const right = syntheticHandPath('right');
    // At least a couple of brush radii apart at every sample, in mask texels.
    for (let i = 0; i < left.length; i++) {
      const dx = (left[i]!.x - right[i]!.x) * MASK_WIDTH;
      const dy = (left[i]!.y - right[i]!.y) * MASK_HEIGHT;
      expect(Math.hypot(dx, dy)).toBeGreaterThan(BRUSH_TUNING.radiusTexels * 3);
    }
  });

  it('encodes 24 valid [1,1,17,3] buffers with both wrists and both elbows live', () => {
    const frames = syntheticKeypointFrames(transform);
    expect(frames).toHaveLength(SYNTHETIC_FRAME_COUNT);
    const wrists = BRUSH_LIMBS.map((limb) => limb.wrist);
    const elbows = BRUSH_LIMBS.map((limb) => limb.elbow);

    for (const frame of frames) {
      expect(frame.length).toBe(KEYPOINT_ELEMENTS);
      for (const wrist of wrists) {
        expect(frame[wrist * 3 + 2]!).toBeGreaterThanOrEqual(BRUSH_TUNING.enterConfidence);
        expect(
          keypointToBrushSpace(frame[wrist * 3]!, frame[wrist * 3 + 1]!, transform),
        ).toBeDefined();
      }
      for (const elbow of elbows) {
        expect(frame[elbow * 3 + 2]!).toBeGreaterThanOrEqual(HAND_EXTRAPOLATION.elbowConfidence);
        expect(
          keypointToBrushSpace(frame[elbow * 3]!, frame[elbow * 3 + 1]!, transform),
        ).toBeDefined();
      }
      // Everything the brushes ignore stays below the enter threshold.
      for (let k = 0; k < KEYPOINT_COUNT; k++) {
        if (wrists.includes(k) || elbows.includes(k)) continue;
        expect(frame[k * 3 + 2]!).toBeLessThan(BRUSH_TUNING.enterConfidence);
      }
    }
  });

  it('places wrist and elbow so the extrapolation lands exactly on the authored hand', () => {
    const frames = syntheticKeypointFrames(transform);
    for (const limb of BRUSH_LIMBS) {
      const path = syntheticHandPath(limb.name);
      frames.forEach((frame, index) => {
        const hand = handFromSample(poseSampleFromKeypoints(frame, limb), transform);
        expect(hand, `${limb.name}[${index}]`).toBeDefined();
        expect(hand!.x).toBeCloseTo(path[index]!.x, 6);
        expect(hand!.y).toBeCloseTo(path[index]!.y, 6);
      });
    }
  });

  it('drives an independent continuous stroke for each hand', () => {
    const frames = syntheticKeypointFrames(transform);
    for (const limb of BRUSH_LIMBS) {
      const state = createBrushSnapshot();
      let painted = 0;
      for (const frame of frames) {
        applyPoseSample(state, poseSampleFromKeypoints(frame, limb), transform, SYNTHETIC_DT);
        if (state.stroke) painted++;
      }
      // One acquisition sample plus 23 painted segments, with no jump breaks.
      expect(painted, limb.name).toBe(SYNTHETIC_FRAME_COUNT - 1);
      expect(state.active, limb.name).toBe(true);
    }
  });
});

describe('two independent brushes', () => {
  const transform = fixtureTransform();

  it('gives every limb its own slot and its own pair of keypoints', () => {
    expect(BRUSH_COUNT).toBe(2);
    expect(BRUSH_LIMBS.map((limb) => limb.name)).toEqual(['left', 'right']);
    expect(BRUSH_LIMBS.map((limb) => limb.wrist)).toEqual([LEFT_WRIST_INDEX, RIGHT_WRIST_INDEX]);
    expect(BRUSH_LIMBS.map((limb) => limb.elbow)).toEqual([LEFT_ELBOW_INDEX, RIGHT_ELBOW_INDEX]);
    // Every index distinct: a shared keypoint would couple the two brushes.
    const all = BRUSH_LIMBS.flatMap((limb) => [limb.wrist, limb.elbow]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('sizes the storage buffer as one padded slot per brush', () => {
    expect(BRUSH_STATE_BYTES).toBe(64);
    expect(BRUSH_BUFFER_BYTES).toBe(BRUSH_STATE_BYTES * BRUSH_COUNT);
    // The 10 live f32 slots have to fit inside the stride, with room to pad.
    expect(BRUSH_STATE_SLOTS * 4).toBeLessThanOrEqual(BRUSH_STATE_BYTES);
  });

  it('does not let one hand losing tracking disturb the other', () => {
    const frames = syntheticKeypointFrames(transform);
    const left = createBrushSnapshot();
    const right = createBrushSnapshot();
    const soloRight = createBrushSnapshot();

    frames.forEach((frame, index) => {
      // Blind the left wrist for a stretch in the middle: two consecutive
      // invalid results is exactly the reset threshold.
      const blinded = index >= 8 && index <= 12;
      const leftSample = poseSampleFromKeypoints(frame, BRUSH_LIMBS[0]!);
      applyPoseSample(
        left,
        blinded ? { ...leftSample, score: 0.01 } : leftSample,
        transform,
        SYNTHETIC_DT,
      );

      const rightSample = poseSampleFromKeypoints(frame, BRUSH_LIMBS[1]!);
      applyPoseSample(right, rightSample, transform, SYNTHETIC_DT);
      applyPoseSample(soloRight, rightSample, transform, SYNTHETIC_DT);
    });

    // The left brush felt the dropout...
    expect(left.strokes).toBeLessThan(SYNTHETIC_FRAME_COUNT - 1);
    // ...and the right brush is bit-for-bit what it would have been alone.
    expect(right).toEqual(soloRight);
  });

  it('keeps two brushes at different positions with no shared term', () => {
    const frames = syntheticKeypointFrames(transform);
    const left = createBrushSnapshot();
    const right = createBrushSnapshot();
    for (const frame of frames) {
      applyPoseSample(left, poseSampleFromKeypoints(frame, BRUSH_LIMBS[0]!), transform, SYNTHETIC_DT);
      applyPoseSample(right, poseSampleFromKeypoints(frame, BRUSH_LIMBS[1]!), transform, SYNTHETIC_DT);
      if (left.active && right.active) {
        expect(Math.hypot(left.current.x - right.current.x, left.current.y - right.current.y))
          .toBeGreaterThan(0.05);
      }
    }
  });
});

describe('hand extrapolation', () => {
  const transform = fixtureTransform();

  it('extends past the wrist, away from the elbow, by the tuned factor', () => {
    const wrist = { x: 0.5, y: 0.4 };
    const elbow = { x: 0.5, y: 0.6 };
    const hand = extrapolateHand(wrist, elbow);
    // Forearm points straight up the frame; the hand continues that way.
    expect(hand.x).toBeCloseTo(0.5, 12);
    expect(hand.y).toBeCloseTo(0.4 - 0.2 * HAND_EXTRAPOLATION.factor, 12);
    expect(hand.y).toBeLessThan(wrist.y);
  });

  it('is the affine combination (1 + k)·wrist - k·elbow', () => {
    const wrist = { x: 0.62, y: 0.31 };
    const elbow = { x: 0.28, y: 0.77 };
    const k = HAND_EXTRAPOLATION.factor;
    const hand = extrapolateHand(wrist, elbow);
    expect(hand.x).toBeCloseTo((1 + k) * wrist.x - k * elbow.x, 12);
    expect(hand.y).toBeCloseTo((1 + k) * wrist.y - k * elbow.y, 12);
  });

  it('gives the same answer in model space as in mirrored brush space', () => {
    // The whole model -> source -> brush chain is affine, and extrapolation is an
    // affine combination, so the two commute. This is why wrist.wgsl is free to
    // extrapolate after mirroring. A non-square frame makes the two axes scale
    // differently, which is exactly where a non-affine mistake would show up.
    const oblong = computeFrameTransform(640, 360);
    const wristKp = { y: 0.42, x: 0.61 };
    const elbowKp = { y: 0.55, x: 0.44 };
    const k = HAND_EXTRAPOLATION.factor;

    // Extrapolate first, in raw model-normalized coordinates, then transform.
    const handKp = {
      y: (1 + k) * wristKp.y - k * elbowKp.y,
      x: (1 + k) * wristKp.x - k * elbowKp.x,
    };
    const viaModel = keypointToBrushSpace(handKp.y, handKp.x, oblong);

    // Transform first, then extrapolate in brush space, which is what runs.
    const viaBrush = extrapolateHand(
      keypointToBrushSpace(wristKp.y, wristKp.x, oblong)!,
      keypointToBrushSpace(elbowKp.y, elbowKp.x, oblong)!,
    );

    expect(viaModel).toBeDefined();
    expect(viaBrush.x).toBeCloseTo(viaModel!.x, 10);
    expect(viaBrush.y).toBeCloseTo(viaModel!.y, 10);
  });

  it('mirrors the extension along with the point', () => {
    // In source space the elbow is left of the wrist, so the hand continues to
    // the right. In the mirrored brush view that has to read as leftwards.
    const oblong = computeFrameTransform(640, 360);
    const wrist = keypointToBrushSpace(0.5, 0.62, oblong)!;
    const elbow = keypointToBrushSpace(0.5, 0.5, oblong)!;
    expect(elbow.x).toBeGreaterThan(wrist.x);
    expect(extrapolateHand(wrist, elbow).x).toBeLessThan(wrist.x);
  });

  it('falls back to the raw wrist when the elbow is not confident enough', () => {
    const sample = {
      y: 0.42,
      x: 0.61,
      score: 0.9,
      elbowY: 0.55,
      elbowX: 0.44,
      elbowScore: HAND_EXTRAPOLATION.elbowConfidence - 0.01,
    };
    const wrist = keypointToBrushSpace(sample.y, sample.x, transform)!;
    const hand = handFromSample(sample, transform)!;
    expect(hand).toEqual(wrist);

    // The same sample with a trustworthy elbow does move the point.
    const extended = handFromSample({ ...sample, elbowScore: 0.9 }, transform)!;
    expect(extended).not.toEqual(wrist);
  });

  it('falls back to the raw wrist when the elbow is missing or off-frame', () => {
    const base = { y: 0.42, x: 0.61, score: 0.9 };
    const wrist = keypointToBrushSpace(base.y, base.x, transform)!;
    expect(handFromSample(base, transform)).toEqual(wrist);
    // In the letterbox padding: a direction from there is not on the person.
    expect(
      handFromSample({ ...base, elbowY: 0.02, elbowX: 0.5, elbowScore: 0.9 }, transform),
    ).toEqual(wrist);
  });

  it('gates on the wrist alone, never on the elbow', () => {
    const state = createBrushSnapshot();
    const confidentWristWeakElbow = {
      y: 0.42,
      x: 0.61,
      score: 0.9,
      elbowY: 0.55,
      elbowX: 0.44,
      elbowScore: 0,
    };
    applyPoseSample(state, confidentWristWeakElbow, transform, SYNTHETIC_DT);
    expect(state.active).toBe(true);
    expect(state.invalid).toBe(0);
  });

  it('clamps into frame rather than dropping a hand reaching for the edge', () => {
    // Wrist near the right edge of brush space with the elbow well inside, so
    // the extension would otherwise overshoot past 1.
    const wrist = { x: 0.98, y: 0.5 };
    const elbow = { x: 0.3, y: 0.5 };
    const hand = extrapolateHand(wrist, elbow);
    expect(hand.x).toBe(1);
    expect(hand.y).toBeCloseTo(0.5, 12);
  });
});
