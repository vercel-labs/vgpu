/**
 * Detector-on-loss cadence and persistent slot identity.
 *
 * MediaPipe's hand solution is fast because it almost never runs the palm
 * detector. It detects once, then rides the landmark model's own output forward:
 * each frame's 21 points define the next frame's crop, so the expensive
 * full-frame search only happens when that loop breaks. This module is that
 * policy, kept pure so the cadence can be tested without a GPU.
 *
 * ## What this module does and does not own
 *
 * It owns the **cadence** (run the detector or not) and **slot assignment**
 * (which detection becomes which persistent track). It does *not* own the brush
 * state machine or the ROI loopback: those live on the GPU in `hand.wgsl`,
 * because moving them here would mean reading 21 landmarks back to the CPU every
 * frame, which is precisely the thing this example exists to avoid.
 *
 * The one signal that does cross back is **hand presence**, a single float per
 * hand. It is requested as a CPU output from ONNX Runtime, so it costs nothing
 * extra — the run promise already has to resolve — and it is not a landmark.
 * Everything else stays on the device.
 *
 * ## Slot identity, and the honest limit of it
 *
 * Slots are track identities, not anatomical labels and not the detector's
 * output order. While both hands are tracked the detector never runs, so
 * identity is perfectly stable: each slot follows its own hand through the
 * landmark loopback.
 *
 * Assignment therefore only happens on the rare reacquisition frame, and it is
 * done by minimising total distance to the last centroid each slot was seen at.
 * That is a heuristic, and it has one known failure: if the hands cross *while*
 * one of them is lost, the two tracks can come back swapped. This is deliberately
 * not defended against with more machinery, because the existing GPU jump cap
 * already handles it correctly — a swapped slot is an implausible teleport, so
 * `has_prev` is dropped and the stroke simply breaks instead of drawing a line
 * across the canvas between two different hands. Breaking a line is the right
 * failure; a cross-hand connector is not.
 */
import {
  MAX_HANDS,
  PRESENCE_ENTER,
  PRESENCE_STAY,
  ROI_MAX_FRACTION,
  ROI_MIN_FRACTION,
  TRACK_LOST_RESULTS,
} from './hand-model-contract';
import { isRoiSane, type HandRoi, type Vec2 } from './hand-pipeline';

/**
 * Results between full-frame searches while at least one hand is still tracked.
 *
 * With one hand up and two slots, one slot is permanently empty, and a literal
 * reading of "detect whenever a slot is free" would run the detector on every
 * single frame for as long as the user paints one-handed — turning the common
 * case into the worst case. Upstream accepts that cost; this example does not,
 * because a second hand appearing half a second late is imperceptible while the
 * frame rate drop would not be.
 *
 * When *no* hand is tracked there is nothing to protect, so the detector runs on
 * every frame until it finds something.
 */
export const DETECTOR_RETRY_RESULTS = 6;

export interface HandCandidate {
  readonly roi: HandRoi;
  /** Palm centre in source pixels, used only for assignment. */
  readonly centroid: Vec2;
  readonly score: number;
}

export interface TrackSlotState {
  /** True while this slot is following a hand. */
  readonly active: boolean;
  /** Most recent hand presence reported by the landmark model. */
  readonly presence: number;
  /** Consecutive results that failed the presence or ROI test. */
  readonly lost: number;
  /** Last centroid recorded for this slot, in source pixels. */
  readonly centroid: Vec2 | undefined;
  /**
   * ROI to crop on the next frame, when the host is the one supplying it.
   * `undefined` means the GPU loopback owns this slot's ROI and the host must
   * not overwrite it.
   */
  readonly pendingRoi: HandRoi | undefined;
}

export interface HandTrackerOptions {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly enterPresence?: number;
  readonly stayPresence?: number;
  readonly lostResults?: number;
  readonly retryResults?: number;
  readonly maxHands?: number;
}

export interface HandTracker {
  readonly slots: readonly TrackSlotState[];
  /** Slots with a hand to crop and run the landmark model on this frame. */
  activeSlots(): readonly number[];
  /** True when this frame must start with a full-frame palm search. */
  needsDetector(): boolean;
  /** Assigns fresh detections to slots. Returns the slots whose ROI the host must upload. */
  acquire(candidates: readonly HandCandidate[]): readonly number[];
  /** Records one landmark result. `presence` is the model's own scalar. */
  noteResult(slot: number, presence: number): void;
  /** Records that a slot produced nothing this frame (no run, or a bad ROI). */
  noteMissing(slot: number): void;
  /**
   * Closes one inference frame.
   *
   * The retry throttle counts *frames*, not slot updates, and a frame reports
   * between zero and two of those, so the count cannot be inferred from the
   * other calls without guessing. The caller says when a frame is over.
   */
  endFrame(): void;
  /** Clears the host-side pending ROI once it has been uploaded. */
  clearPending(slot: number): void;
  /** Drops every track, so the next frame reacquires from scratch. */
  reset(): void;
  resize(sourceWidth: number, sourceHeight: number): void;
}

interface MutableSlot {
  active: boolean;
  presence: number;
  lost: number;
  centroid: Vec2 | undefined;
  pendingRoi: HandRoi | undefined;
}

function createSlot(): MutableSlot {
  return { active: false, presence: 0, lost: 0, centroid: undefined, pendingRoi: undefined };
}

export function createHandTracker(options: HandTrackerOptions): HandTracker {
  const enterPresence = options.enterPresence ?? PRESENCE_ENTER;
  const stayPresence = options.stayPresence ?? PRESENCE_STAY;
  const lostResults = options.lostResults ?? TRACK_LOST_RESULTS;
  const retryResults = options.retryResults ?? DETECTOR_RETRY_RESULTS;
  const maxHands = options.maxHands ?? MAX_HANDS;

  let sourceWidth = options.sourceWidth;
  let sourceHeight = options.sourceHeight;
  const slots: MutableSlot[] = Array.from({ length: maxHands }, createSlot);
  let sinceDetector = Number.POSITIVE_INFINITY;
  /**
   * Set when a slot that *was* tracking a hand goes bad.
   *
   * This is the difference between "a hand I was following just disappeared" and
   * "there has only ever been one hand up". The first deserves an immediate
   * search, because the user probably moved fast or briefly occluded a hand and
   * is waiting to carry on painting. The second is the steady state of
   * one-handed use and must not be allowed to run the detector forever.
   */
  let lostSinceDetector = false;

  const anyActive = () => slots.some((slot) => slot.active);

  /** Drops a slot's track, remembering that a real hand was lost. */
  const deactivate = (slot: MutableSlot) => {
    if (slot.active) lostSinceDetector = true;
    slot.active = false;
    slot.pendingRoi = undefined;
    // The last centroid is kept on purpose: it is the best guess available when
    // this slot is reacquired, and it is what stops the two tracks swapping
    // over a brief dropout.
  };

  return {
    get slots() {
      return slots.map((slot) => ({ ...slot }));
    },

    activeSlots() {
      const out: number[] = [];
      for (let i = 0; i < slots.length; i++) if (slots[i]!.active) out.push(i);
      return out;
    },

    needsDetector() {
      const free = slots.filter((slot) => !slot.active).length;
      if (free === 0) return false;
      // Nothing to lose: search every frame until a hand turns up.
      if (!anyActive()) return true;
      // A hand that was being followed just went away. Go and find it now
      // rather than making the user wait out the throttle.
      if (lostSinceDetector) return true;
      return sinceDetector >= retryResults;
    },

    acquire(candidates) {
      sinceDetector = 0;
      lostSinceDetector = false;
      const free: number[] = [];
      for (let i = 0; i < slots.length; i++) if (!slots[i]!.active) free.push(i);
      if (free.length === 0 || candidates.length === 0) return [];

      // Detections a still-healthy slot is already following must not be handed
      // to a free slot as well, or both brushes would paint the same hand.
      const claimed = new Set<number>();
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!;
        if (!slot.active || !slot.centroid) continue;
        const nearest = nearestCandidate(slot.centroid, candidates, claimed);
        if (nearest !== undefined) claimed.add(nearest);
      }

      const available = candidates
        .map((candidate, index) => ({ candidate, index }))
        .filter((entry) => !claimed.has(entry.index));
      if (available.length === 0) return [];

      const assignment = assignByDistance(
        free.map((slot) => slots[slot]!.centroid),
        available.map((entry) => entry.candidate.centroid),
      );

      const uploaded: number[] = [];
      for (let i = 0; i < assignment.length; i++) {
        const candidateIndex = assignment[i];
        if (candidateIndex === undefined) continue;
        const slotIndex = free[i]!;
        const entry = available[candidateIndex]!;
        if (!isRoiSane(entry.candidate.roi, sourceWidth, sourceHeight, ROI_MIN_FRACTION, ROI_MAX_FRACTION)) {
          continue;
        }
        const slot = slots[slotIndex]!;
        slot.active = true;
        slot.lost = 0;
        // Deliberately not seeded from the detector score. A palm can score 0.58
        // and still come back with landmark presence 0.017; only the landmark
        // model gets to say a hand is really there.
        slot.presence = 0;
        slot.centroid = entry.candidate.centroid;
        slot.pendingRoi = entry.candidate.roi;
        uploaded.push(slotIndex);
      }
      return uploaded;
    },

    noteResult(slot, presence) {
      const state = slots[slot];
      if (!state) return;
      const threshold = state.lost === 0 && state.presence > 0 ? stayPresence : enterPresence;
      const present = Number.isFinite(presence) && presence >= threshold;
      state.presence = Number.isFinite(presence) ? Math.max(0, presence) : 0;
      if (present) {
        state.lost = 0;
        state.active = true;
        return;
      }
      state.lost += 1;
      if (state.lost >= lostResults) deactivate(state);
    },

    noteMissing(slot) {
      const state = slots[slot];
      if (!state) return;
      state.lost += 1;
      state.presence = 0;
      if (state.lost >= lostResults) deactivate(state);
    },

    endFrame() {
      sinceDetector += 1;
    },

    clearPending(slot) {
      const state = slots[slot];
      if (state) state.pendingRoi = undefined;
    },

    reset() {
      for (const slot of slots) {
        slot.active = false;
        slot.presence = 0;
        slot.lost = 0;
        slot.centroid = undefined;
        slot.pendingRoi = undefined;
      }
      sinceDetector = Number.POSITIVE_INFINITY;
      lostSinceDetector = false;
    },

    resize(width, height) {
      sourceWidth = width;
      sourceHeight = height;
    },
  };
}

function distance(a: Vec2 | undefined, b: Vec2 | undefined): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function nearestCandidate(
  centroid: Vec2,
  candidates: readonly HandCandidate[],
  claimed: ReadonlySet<number>,
): number | undefined {
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < candidates.length; i++) {
    if (claimed.has(i)) continue;
    const d = distance(centroid, candidates[i]!.centroid);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

/**
 * Minimum-total-distance assignment of candidates to slots.
 *
 * Returns, per slot, the index of the candidate it should take, or `undefined`.
 * With at most two of each this is a comparison of two permutations rather than
 * a real assignment problem; what matters is only that the answer does not
 * depend on the order the detector happened to emit its boxes, which is what the
 * reversed-order test pins.
 *
 * Slots with no history sort by x so a cold start is at least deterministic.
 */
export function assignByDistance(
  slotCentroids: readonly (Vec2 | undefined)[],
  candidateCentroids: readonly Vec2[],
): readonly (number | undefined)[] {
  const slotCount = slotCentroids.length;
  const result: (number | undefined)[] = new Array(slotCount).fill(undefined);
  if (candidateCentroids.length === 0 || slotCount === 0) return result;

  const known = slotCentroids.some((centroid) => centroid !== undefined);
  if (!known) {
    const order = candidateCentroids
      .map((centroid, index) => ({ centroid, index }))
      .sort((a, b) => a.centroid.x - b.centroid.x);
    for (let slot = 0; slot < slotCount && slot < order.length; slot++) {
      result[slot] = order[slot]!.index;
    }
    return result;
  }

  const permutations = permute(candidateCentroids.map((_, index) => index));
  let bestCost = Number.POSITIVE_INFINITY;
  let best: (number | undefined)[] = result;

  for (const permutation of permutations) {
    const attempt: (number | undefined)[] = new Array(slotCount).fill(undefined);
    let cost = 0;
    for (let slot = 0; slot < slotCount; slot++) {
      const candidate = permutation[slot];
      if (candidate === undefined) continue;
      attempt[slot] = candidate;
      const d = distance(slotCentroids[slot], candidateCentroids[candidate]);
      // A slot with no history contributes nothing, so it never outvotes a slot
      // that does have a position to be consistent with.
      cost += Number.isFinite(d) ? d : 0;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = attempt;
    }
  }
  return best;
}

function permute(values: readonly number[]): number[][] {
  if (values.length <= 1) return [[...values]];
  const out: number[][] = [];
  for (let i = 0; i < values.length; i++) {
    const rest = [...values.slice(0, i), ...values.slice(i + 1)];
    for (const tail of permute(rest)) out.push([values[i]!, ...tail]);
  }
  return out;
}
