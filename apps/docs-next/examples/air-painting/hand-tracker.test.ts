/**
 * Detector cadence and persistent slot identity.
 *
 * The cases here are the ones that decide whether the example feels solid or
 * haunted: a slot that swaps hands draws a line across the canvas, a detector
 * that never reruns leaves the second hand dead, and one that reruns every frame
 * turns a 6 ms tracked frame into a 36 ms acquisition frame forever.
 */
import { describe, expect, it } from 'vitest';
import {
  assignByDistance,
  createHandTracker,
  DETECTOR_RETRY_RESULTS,
  type HandCandidate,
} from './hand-tracker';
import { PRESENCE_ENTER, TRACK_LOST_RESULTS } from './hand-model-contract';
import type { HandRoi } from './hand-pipeline';

const SOURCE_WIDTH = 640;
const SOURCE_HEIGHT = 360;

function roiAt(x: number, y: number, size = 120): HandRoi {
  return { cx: x, cy: y, size, rotation: 0 };
}

function candidate(x: number, y: number, score = 0.9): HandCandidate {
  return { roi: roiAt(x, y), centroid: { x, y }, score };
}

function tracker() {
  return createHandTracker({ sourceWidth: SOURCE_WIDTH, sourceHeight: SOURCE_HEIGHT });
}

/** Feeds a healthy landmark result to every active slot and closes the frame. */
function keepAlive(t: ReturnType<typeof tracker>, presence = 0.95) {
  for (const slot of t.activeSlots()) t.noteResult(slot, presence);
  t.endFrame();
}

describe('detector cadence', () => {
  it('runs the detector at startup, when nothing is tracked', () => {
    expect(tracker().needsDetector()).toBe(true);
  });

  it('stops running the detector once both slots are tracked', () => {
    const t = tracker();
    t.acquire([candidate(150, 180), candidate(500, 180)]);
    keepAlive(t);
    expect(t.activeSlots()).toEqual([0, 1]);
    // This is the whole performance story: a tracked frame must not pay for a
    // full-frame search.
    expect(t.needsDetector()).toBe(false);
  });

  it('searches every frame while no hand is tracked at all', () => {
    const t = tracker();
    t.acquire([]);
    expect(t.needsDetector()).toBe(true);
    t.acquire([]);
    expect(t.needsDetector()).toBe(true);
  });

  it('throttles the retry while one hand is still tracked', () => {
    const t = tracker();
    t.acquire([candidate(150, 180)]);
    keepAlive(t);
    expect(t.activeSlots()).toEqual([0]);
    // A free slot exists, but hunting for it every frame would make one-handed
    // painting permanently pay the acquisition cost.
    expect(t.needsDetector()).toBe(false);

    for (let i = 0; i < DETECTOR_RETRY_RESULTS; i++) keepAlive(t);
    expect(t.needsDetector()).toBe(true);
  });

  it('reacquires as soon as a tracked hand is lost', () => {
    const t = tracker();
    t.acquire([candidate(150, 180), candidate(500, 180)]);
    keepAlive(t);
    expect(t.needsDetector()).toBe(false);

    for (let i = 0; i < TRACK_LOST_RESULTS; i++) {
      t.noteResult(0, 0.01);
      t.noteResult(1, 0.95);
      t.endFrame();
    }
    expect(t.activeSlots()).toEqual([1]);
    // A hand that was being followed just vanished: search now, do not make the
    // user wait out the one-handed throttle.
    expect(t.needsDetector()).toBe(true);
  });
});

describe('presence gating', () => {
  it('never seeds confidence from the detector score', () => {
    const t = tracker();
    // A real photograph scored 0.9 at the detector and 0.017 at the landmark
    // model. The slot must start at zero confidence and wait to be told.
    t.acquire([candidate(150, 180, 0.9)]);
    expect(t.slots[0]!.presence).toBe(0);
  });

  it('drops a slot after the configured run of absent results', () => {
    const t = tracker();
    t.acquire([candidate(150, 180)]);
    t.noteResult(0, 0.95);
    expect(t.slots[0]!.active).toBe(true);

    t.noteResult(0, 0.01);
    expect(t.slots[0]!.active).toBe(true);
    t.noteResult(0, 0.01);
    expect(t.slots[0]!.active).toBe(false);
  });

  it('treats a NaN presence as absent rather than as a pass', () => {
    const t = tracker();
    t.acquire([candidate(150, 180)]);
    t.noteResult(0, Number.NaN);
    t.noteResult(0, Number.NaN);
    expect(t.slots[0]!.active).toBe(false);
    expect(Number.isFinite(t.slots[0]!.presence)).toBe(true);
  });

  it('needs the enter threshold on a fresh slot', () => {
    const t = tracker();
    t.acquire([candidate(150, 180)]);
    t.noteResult(0, PRESENCE_ENTER - 0.01);
    t.noteResult(0, PRESENCE_ENTER - 0.01);
    expect(t.slots[0]!.active).toBe(false);
  });

  it('counts a slot that did not run as missing', () => {
    const t = tracker();
    t.acquire([candidate(150, 180)]);
    t.noteResult(0, 0.95);
    for (let i = 0; i < TRACK_LOST_RESULTS; i++) t.noteMissing(0);
    expect(t.slots[0]!.active).toBe(false);
  });
});

describe('slot assignment', () => {
  it('is deterministic on a cold start, ordered by x', () => {
    const t = tracker();
    t.acquire([candidate(500, 180), candidate(150, 180)]);
    // Left-most hand takes slot 0 regardless of emission order.
    expect(t.slots[0]!.centroid?.x).toBe(150);
    expect(t.slots[1]!.centroid?.x).toBe(500);
  });

  it('does not depend on the order the detector emitted its boxes', () => {
    const forward = tracker();
    forward.acquire([candidate(150, 180), candidate(500, 180)]);
    const reversed = tracker();
    reversed.acquire([candidate(500, 180), candidate(150, 180)]);
    expect(reversed.slots.map((s) => s.centroid?.x)).toEqual(
      forward.slots.map((s) => s.centroid?.x),
    );
  });

  it('keeps a healthy slot on its own hand when the other reacquires', () => {
    const t = tracker();
    t.acquire([candidate(150, 180), candidate(500, 180)]);
    keepAlive(t);

    // Slot 1 drops out.
    for (let i = 0; i < TRACK_LOST_RESULTS; i++) {
      t.noteResult(0, 0.95);
      t.noteResult(1, 0.01);
      t.endFrame();
    }
    expect(t.activeSlots()).toEqual([0]);

    // The detector sees both hands again, roughly where they were.
    t.acquire([candidate(160, 185), candidate(505, 182)]);
    // The hand near slot 0's position must not be handed to the free slot as
    // well, or both brushes would paint the same hand.
    expect(t.slots[1]!.centroid?.x).toBe(505);
    expect(t.slots[0]!.centroid?.x).toBe(150);
  });

  it('does not steal the only detection from a healthy slot', () => {
    const t = tracker();
    t.acquire([candidate(150, 180)]);
    keepAlive(t);
    for (let i = 0; i < DETECTOR_RETRY_RESULTS; i++) keepAlive(t);

    // Same single hand found again: there is no second hand to give slot 1.
    t.acquire([candidate(155, 182)]);
    expect(t.slots[1]!.active).toBe(false);
    expect(t.activeSlots()).toEqual([0]);
  });

  it('remembers where a lost slot was, so a brief dropout does not swap tracks', () => {
    const t = tracker();
    t.acquire([candidate(150, 180), candidate(500, 180)]);
    keepAlive(t);
    for (let i = 0; i < TRACK_LOST_RESULTS; i++) {
      t.noteResult(0, 0.01);
      t.noteResult(1, 0.01);
      t.endFrame();
    }
    expect(t.activeSlots()).toEqual([]);

    // Both hands come back, emitted in the opposite order this time.
    t.acquire([candidate(505, 178), candidate(148, 176)]);
    expect(t.slots[0]!.centroid?.x).toBe(148);
    expect(t.slots[1]!.centroid?.x).toBe(505);
  });

  it('refuses a detection whose ROI is not physically plausible', () => {
    const t = tracker();
    t.acquire([{ roi: roiAt(150, 180, 1), centroid: { x: 150, y: 180 }, score: 0.9 }]);
    expect(t.slots[0]!.active).toBe(false);
  });

  it('hands back exactly the slots whose ROI the host must upload', () => {
    const t = tracker();
    const uploaded = t.acquire([candidate(150, 180), candidate(500, 180)]);
    expect(uploaded).toEqual([0, 1]);
    for (const slot of uploaded) {
      expect(t.slots[slot]!.pendingRoi).toBeDefined();
      t.clearPending(slot);
      expect(t.slots[slot]!.pendingRoi).toBeUndefined();
    }
  });

  it('reset drops every track so the next frame starts clean', () => {
    const t = tracker();
    t.acquire([candidate(150, 180), candidate(500, 180)]);
    keepAlive(t);
    t.reset();
    expect(t.activeSlots()).toEqual([]);
    expect(t.slots.every((slot) => slot.centroid === undefined)).toBe(true);
    expect(t.needsDetector()).toBe(true);
  });
});

describe('assignByDistance', () => {
  it('picks the permutation with the lowest total distance', () => {
    const assignment = assignByDistance(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      [
        { x: 95, y: 5 },
        { x: 5, y: 5 },
      ],
    );
    expect(assignment).toEqual([1, 0]);
  });

  it('is stable when the candidate order reverses', () => {
    const slots = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const a = assignByDistance(slots, [
      { x: 5, y: 0 },
      { x: 95, y: 0 },
    ]);
    const b = assignByDistance(slots, [
      { x: 95, y: 0 },
      { x: 5, y: 0 },
    ]);
    // Different indices, but each slot ends up with the same physical point.
    expect(a).toEqual([0, 1]);
    expect(b).toEqual([1, 0]);
  });

  it('falls back to x order when no slot has any history', () => {
    expect(
      assignByDistance(
        [undefined, undefined],
        [
          { x: 100, y: 0 },
          { x: 10, y: 0 },
        ],
      ),
    ).toEqual([1, 0]);
  });

  it('handles fewer candidates than slots', () => {
    const assignment = assignByDistance([{ x: 0, y: 0 }, undefined], [{ x: 5, y: 0 }]);
    expect(assignment[0]).toBe(0);
    expect(assignment[1]).toBeUndefined();
  });

  it('handles no candidates at all', () => {
    expect(assignByDistance([{ x: 0, y: 0 }], [])).toEqual([undefined]);
  });
});
