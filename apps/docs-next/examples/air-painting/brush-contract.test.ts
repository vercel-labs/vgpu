/**
 * The brush half of the air-painting contract.
 *
 * These tests are the MoveNet-era suite with the model-specific cases moved out
 * to `hand-pipeline.test.ts` and `hand-tracker.test.ts`. The state machine cases
 * are deliberately unchanged in intent: the hand swap replaced what feeds the
 * brush, not how the brush behaves, and if any of these had to be relaxed to
 * make the new estimator fit, that would have been the swap breaking something
 * it promised not to touch.
 */
import { describe, expect, it } from 'vitest';
import {
  applyHandMeasurement,
  BRUSH_BUFFER_BYTES,
  BRUSH_COUNT,
  BRUSH_SLOTS,
  BRUSH_SPACE_DIAGONAL,
  BRUSH_STATE_BYTES,
  BRUSH_STATE_SLOTS,
  BRUSH_TUNING,
  createBrushSnapshot,
  fogDecay,
  FOG_TUNING,
  MASK_BYTES,
  MASK_HEIGHT,
  MASK_TEXELS,
  MASK_WIDTH,
  MAX_FOG_DT,
  MAX_SMOOTHING_DT,
  maxJumpDistance,
  refogTexel,
  ROI_BYTES,
  ROI_DETECTOR_SLOT,
  ROI_SLOT_COUNT,
  smoothingAlpha,
  type BrushSnapshot,
  type HandMeasurement,
} from './brush-contract';
import {
  canonicalHandLandmarks,
  cropSpaceMcpCentroid,
  FIXTURE_FRAME_HEIGHT,
  FIXTURE_FRAME_WIDTH,
  SYNTHETIC_DT,
  SYNTHETIC_FRAME_COUNT,
  syntheticHandFrames,
  syntheticHandPath,
  syntheticPresence,
} from './fixtures';
import { MCP_LANDMARKS, NUM_LANDMARKS } from './hand-model-contract';
import { landmarkToSource, mcpCentroid } from './hand-pipeline';
import { sourceToBrush } from './hand-preprocess';

/** A measurement that will be accepted, unless the caller says otherwise. */
function measurement(x: number, y: number, confidence = 0.9, slot = 0): HandMeasurement {
  return { slot, x, y, confidence };
}

describe('frozen brush contract', () => {
  it('bounds the persistent mask', () => {
    expect(MASK_WIDTH).toBe(960);
    expect(MASK_HEIGHT).toBe(540);
    expect(MASK_TEXELS).toBe(MASK_WIDTH * MASK_HEIGHT);
    expect(MASK_BYTES).toBe(MASK_TEXELS * 4);
  });

  it('keeps two brushes with the 64-byte slot ABI the shaders bind', () => {
    expect(BRUSH_COUNT).toBe(2);
    expect(BRUSH_SLOTS).toEqual([0, 1]);
    // The struct is 40 bytes; `@size(28)` pads the array stride to 64.
    expect(BRUSH_STATE_SLOTS).toBe(10);
    expect(BRUSH_STATE_BYTES).toBe(64);
    expect(BRUSH_BUFFER_BYTES).toBe(BRUSH_STATE_BYTES * BRUSH_COUNT);
  });

  it('sizes the ROI buffer as two hands plus the detector letterbox', () => {
    expect(ROI_SLOT_COUNT).toBe(3);
    expect(ROI_DETECTOR_SLOT).toBe(2);
    // vec2f centre + f32 size + f32 rotation, so 16 bytes and no padding.
    expect(ROI_BYTES).toBe(ROI_SLOT_COUNT * 16);
  });
});

describe('EMA smoothing', () => {
  it('matches the shader expression and is monotonic in dt', () => {
    const tau = BRUSH_TUNING.emaTauSeconds;
    expect(smoothingAlpha(0)).toBe(0);
    expect(smoothingAlpha(tau)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(smoothingAlpha(0.02)).toBeLessThan(smoothingAlpha(0.05));
  });

  it('clamps a backgrounded-tab dt so the brush cannot teleport', () => {
    expect(smoothingAlpha(10)).toBe(smoothingAlpha(MAX_SMOOTHING_DT));
    expect(smoothingAlpha(-1)).toBe(0);
  });
});

describe('hand state machine', () => {
  const dt = 1 / 30;

  it('needs the enter threshold to acquire and paints nothing on acquisition', () => {
    const state = createBrushSnapshot();
    applyHandMeasurement(state, measurement(0.5, 0.5, BRUSH_TUNING.enterConfidence - 0.01), dt);
    expect(state.active).toBe(false);
    expect(state.stroke).toBe(false);

    applyHandMeasurement(state, measurement(0.5, 0.5, BRUSH_TUNING.enterConfidence), dt);
    expect(state.active).toBe(true);
    // Acquisition seeds continuity and deliberately draws nothing.
    expect(state.stroke).toBe(false);
    expect(state.strokes).toBe(0);
  });

  it('paints a segment once continuity exists', () => {
    const state = createBrushSnapshot();
    applyHandMeasurement(state, measurement(0.4, 0.5), dt);
    applyHandMeasurement(state, measurement(0.45, 0.5), dt);
    expect(state.stroke).toBe(true);
    expect(state.strokes).toBe(1);
    expect(state.prev.x).toBeCloseTo(0.4, 10);
    expect(state.current.x).toBeGreaterThan(0.4);
  });

  it('keeps painting between the stay and enter thresholds (hysteresis)', () => {
    const state = createBrushSnapshot();
    applyHandMeasurement(state, measurement(0.4, 0.5, 0.9), dt);
    applyHandMeasurement(state, measurement(0.42, 0.5, 0.9), dt);
    const between = (BRUSH_TUNING.stayConfidence + BRUSH_TUNING.enterConfidence) / 2;
    applyHandMeasurement(state, measurement(0.44, 0.5, between), dt);
    expect(state.active).toBe(true);
    expect(state.stroke).toBe(true);
  });

  it('drops the track after two invalid results and never draws a connector', () => {
    const state = createBrushSnapshot();
    applyHandMeasurement(state, measurement(0.4, 0.5), dt);
    applyHandMeasurement(state, measurement(0.45, 0.5), dt);
    expect(state.active).toBe(true);

    applyHandMeasurement(state, undefined, dt);
    expect(state.active).toBe(true);
    expect(state.invalid).toBe(1);

    applyHandMeasurement(state, undefined, dt);
    expect(state.active).toBe(false);
    expect(state.hasPrev).toBe(false);
    expect(state.invalid).toBe(BRUSH_TUNING.invalidResetCount);

    // Reacquiring somewhere else must not connect back to the old position.
    applyHandMeasurement(state, measurement(0.9, 0.9), dt);
    expect(state.active).toBe(true);
    expect(state.stroke).toBe(false);
  });

  it('rejects NaN and out-of-range measurements', () => {
    for (const bad of [
      measurement(Number.NaN, 0.5),
      measurement(0.5, Number.NaN),
      measurement(0.5, 0.5, Number.NaN),
      measurement(-0.01, 0.5),
      measurement(0.5, 1.01),
    ]) {
      const state = createBrushSnapshot();
      applyHandMeasurement(state, bad, dt);
      expect(state.active).toBe(false);
      expect(state.stroke).toBe(false);
      expect(Number.isFinite(state.confidence)).toBe(true);
    }
  });

  it('treats a present hand with zero confidence as absent', () => {
    const state = createBrushSnapshot();
    applyHandMeasurement(state, measurement(0.5, 0.5, 0), dt);
    expect(state.active).toBe(false);
    expect(state.confidence).toBe(0);
  });

  it('breaks the line on an implausible jump instead of drawing across the frame', () => {
    const state = createBrushSnapshot();
    applyHandMeasurement(state, measurement(0.1, 0.1), dt);
    applyHandMeasurement(state, measurement(0.12, 0.1), dt);
    expect(state.stroke).toBe(true);

    // A slot swapped by a bad reacquisition presents exactly like this.
    applyHandMeasurement(state, measurement(0.95, 0.95), 1);
    expect(state.stroke).toBe(false);
    expect(state.hasPrev).toBe(false);
    expect(state.active).toBe(true);
    expect(state.current.x).toBeCloseTo(0.95, 10);
  });

  it('accepts a step just under the jump cap', () => {
    const cap = maxJumpDistance();
    expect(cap).toBeCloseTo(BRUSH_TUNING.maxJumpFraction * BRUSH_SPACE_DIAGONAL, 12);
    const state = createBrushSnapshot();
    applyHandMeasurement(state, measurement(0.5, 0.5), dt);
    applyHandMeasurement(state, measurement(0.5, 0.5), dt);
    // A dt large enough that alpha is ~1, so the step is the full distance.
    const step = cap * 0.9;
    applyHandMeasurement(state, measurement(0.5 + step, 0.5), 10);
    expect(state.stroke).toBe(true);
  });

  it('reset drops continuity without losing the tracked position', () => {
    const state = createBrushSnapshot();
    applyHandMeasurement(state, measurement(0.4, 0.5), dt);
    applyHandMeasurement(state, measurement(0.42, 0.5), dt);
    const held = { ...state.current };

    applyHandMeasurement(state, measurement(0.44, 0.5), dt, { reset: true });
    expect(state.stroke).toBe(false);
    expect(state.active).toBe(true);
    expect(state.current.x).not.toBe(held.x);

    applyHandMeasurement(state, measurement(0.46, 0.5), dt);
    expect(state.stroke).toBe(true);
  });
});

describe('re-fog decay', () => {
  const tau = FOG_TUNING.refogTauSeconds;

  it('is exp(-dt / tau) for a normal frame', () => {
    expect(fogDecay(1 / 30)).toBeCloseTo(Math.exp(-1 / 30 / tau), 12);
  });

  it('halves the wipe every tau * ln 2 seconds', () => {
    // Composed rather than taken in one step, because a single step of
    // tau * ln 2 would be clamped by MAX_FOG_DT. The half-life is a property of
    // the accumulated curve, which is the thing that actually runs.
    const dt = 1 / 30;
    const steps = Math.round((tau * Math.LN2) / dt);
    let value = 1;
    for (let i = 0; i < steps; i++) value *= fogDecay(dt);
    // Exact: composing n steps of dt is one step of n*dt. That is the property
    // that makes the fog curve independent of the inference rate.
    expect(value).toBeCloseTo(Math.exp(-(steps * dt) / tau), 12);
    // ...and that lands on half a wipe, to within the half-frame of slack that
    // rounding 145.6 frames to 146 leaves behind.
    expect(value).toBeCloseTo(0.5, 2);
  });

  it('composes, so the fog does not depend on the inference rate', () => {
    const slow = fogDecay(1 / 15);
    const fast = fogDecay(1 / 60);
    expect(fast ** 4).toBeCloseTo(slow, 12);
  });

  it('clamps dt so a stalled tab does not fog over in one step', () => {
    expect(fogDecay(10)).toBe(fogDecay(MAX_FOG_DT));
    expect(fogDecay(-1)).toBe(1);
  });

  it('refogs monotonically toward zero once the hand stops wiping', () => {
    let value = 1;
    let previous = Number.POSITIVE_INFINITY;
    // Long enough to cross the clearEpsilon floor: at 30 Hz and tau = 7 s that
    // takes about 1,170 results, i.e. roughly 39 seconds of walking away.
    for (let i = 0; i < 1500; i++) {
      value = refogTexel(value, 0, 1 / 30);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
    expect(value).toBe(0);
  });

  it('snaps to exactly zero instead of leaving glass permanently unclean', () => {
    const value = refogTexel(FOG_TUNING.clearEpsilon * 0.9, 0, 1 / 30);
    expect(value).toBe(0);
  });

  it('lets an active wipe win over the decay via max', () => {
    expect(refogTexel(0.2, 0.9, 1 / 30)).toBeCloseTo(0.9, 10);
    expect(refogTexel(0.95, 0.1, 1 / 30)).toBeGreaterThan(0.9);
  });

  it('never exceeds fully clean glass', () => {
    expect(refogTexel(1, 5, 1 / 30)).toBe(1);
  });
});

describe('two independent brushes', () => {
  const dt = 1 / 30;

  it('does not let one hand losing tracking disturb the other', () => {
    const slots: BrushSnapshot[] = [createBrushSnapshot(), createBrushSnapshot()];
    for (let i = 0; i < 4; i++) {
      applyHandMeasurement(slots[0]!, measurement(0.2 + i * 0.02, 0.3), dt);
      applyHandMeasurement(slots[1]!, measurement(0.8 - i * 0.02, 0.7, 0.9, 1), dt);
    }
    expect(slots[0]!.active).toBe(true);
    expect(slots[1]!.active).toBe(true);
    const survivorStrokes = slots[1]!.strokes;

    // Slot 0 drops out entirely.
    applyHandMeasurement(slots[0]!, undefined, dt);
    applyHandMeasurement(slots[0]!, undefined, dt);
    applyHandMeasurement(slots[1]!, measurement(0.7, 0.7, 0.9, 1), dt);

    expect(slots[0]!.active).toBe(false);
    expect(slots[1]!.active).toBe(true);
    expect(slots[1]!.strokes).toBe(survivorStrokes + 1);
  });

  it('keeps two brushes at different positions with no shared term', () => {
    const slots: BrushSnapshot[] = [createBrushSnapshot(), createBrushSnapshot()];
    applyHandMeasurement(slots[0]!, measurement(0.25, 0.25), dt);
    applyHandMeasurement(slots[1]!, measurement(0.75, 0.75, 0.9, 1), dt);
    expect(slots[0]!.current).not.toEqual(slots[1]!.current);
    expect(slots[0]!.current.x).toBeCloseTo(0.25, 10);
    expect(slots[1]!.current.x).toBeCloseTo(0.75, 10);
  });
});

describe('synthetic fixtures', () => {
  const frames = syntheticHandFrames(FIXTURE_FRAME_WIDTH, FIXTURE_FRAME_HEIGHT);

  it('encodes 24 results per slot as real [1,63] landmark buffers', () => {
    expect(frames).toHaveLength(SYNTHETIC_FRAME_COUNT);
    for (const frame of frames) {
      expect(frame.results).toHaveLength(2);
      for (const result of frame.results) {
        expect(result.landmarks).toHaveLength(NUM_LANDMARKS * 3);
        expect(Array.from(result.landmarks).every(Number.isFinite)).toBe(true);
        expect(result.roi.size).toBeGreaterThan(0);
      }
    }
  });

  it('centres the canonical hand so its MCP centroid is the middle of the crop', () => {
    const canonical = canonicalHandLandmarks();
    expect(canonical).toHaveLength(NUM_LANDMARKS);
    const centroid = mcpCentroid(canonical);
    // This is what lets every other fixture assertion be an equality.
    expect(centroid.x).toBeCloseTo(0.5, 12);
    expect(centroid.y).toBeCloseTo(0.5, 12);
    for (const result of frames[0]!.results) {
      // Through a Float32Array, so float32 epsilon is the floor here.
      const inCrop = cropSpaceMcpCentroid(result);
      expect(inCrop.x).toBeCloseTo(0.5, 6);
      expect(inCrop.y).toBeCloseTo(0.5, 6);
    }
  });

  it('lands each result exactly on the brush-space point it was authored from', () => {
    for (const frame of frames) {
      for (const result of frame.results) {
        const points = landmarkToSource(result.landmarks, result.roi, 224);
        const centroid = mcpCentroid(points);
        const brush = sourceToBrush(centroid, FIXTURE_FRAME_WIDTH, FIXTURE_FRAME_HEIGHT);
        expect(brush.x).toBeCloseTo(result.expected.x, 6);
        expect(brush.y).toBeCloseTo(result.expected.y, 6);
      }
    }
  });

  it('sweeps a wide range of ROI rotations so a dropped sin cannot pass', () => {
    const rotations = frames.flatMap((frame) => frame.results.map((r) => r.roi.rotation));
    const spread = Math.max(...rotations) - Math.min(...rotations);
    expect(spread).toBeGreaterThan(0.5);
    expect(rotations.some((r) => Math.abs(r) > 0.2)).toBe(true);
  });

  it('keeps both hand paths inside the frame', () => {
    for (const slot of [0, 1]) {
      for (const point of syntheticHandPath(slot)) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(1);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(1);
      }
    }
  });

  it('separates the two paths so they read as two strokes, not one', () => {
    const a = syntheticHandPath(0);
    const b = syntheticHandPath(1);
    // Three brush radii in mask texels, expressed as a fraction of the height.
    const minimum = (3 * BRUSH_TUNING.radiusTexels) / MASK_HEIGHT;
    for (let i = 0; i < a.length; i++) {
      expect(Math.hypot(a[i]!.x - b[i]!.x, a[i]!.y - b[i]!.y)).toBeGreaterThan(minimum);
    }
  });

  it('ramps presence across the enter threshold and stays above stay', () => {
    expect(syntheticPresence(0)).toBeGreaterThanOrEqual(BRUSH_TUNING.enterConfidence);
    for (let i = 0; i < SYNTHETIC_FRAME_COUNT; i++) {
      expect(syntheticPresence(i)).toBeGreaterThan(BRUSH_TUNING.stayConfidence);
    }
  });

  it('drives an independent continuous stroke for each slot', () => {
    const slots: BrushSnapshot[] = [createBrushSnapshot(), createBrushSnapshot()];
    for (const frame of frames) {
      for (const result of frame.results) {
        const points = landmarkToSource(result.landmarks, result.roi, 224);
        const brush = sourceToBrush(
          mcpCentroid(points),
          FIXTURE_FRAME_WIDTH,
          FIXTURE_FRAME_HEIGHT,
        );
        applyHandMeasurement(
          slots[result.slot]!,
          { slot: result.slot, x: brush.x, y: brush.y, confidence: result.presence },
          SYNTHETIC_DT,
        );
      }
    }
    for (const slot of slots) {
      expect(slot.active).toBe(true);
      // One acquisition frame draws nothing; every later one paints.
      expect(slot.strokes).toBe(SYNTHETIC_FRAME_COUNT - 1);
    }
  });

  it('uses every MCP landmark, so a wrong index would move the stroke', () => {
    const canonical = canonicalHandLandmarks();
    for (const index of MCP_LANDMARKS) {
      const nudged = canonical.map((point, i) =>
        i === index ? { x: point.x + 0.1, y: point.y } : point,
      );
      expect(mcpCentroid(nudged).x).not.toBeCloseTo(0.5, 6);
    }
  });
});
