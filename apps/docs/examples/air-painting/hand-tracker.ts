import {
  PRESENCE_ENTER,
  PRESENCE_STAY,
  ROI_MAX_FRACTION,
  ROI_MIN_FRACTION,
  TRACK_LOST_RESULTS,
} from "./hand-model-contract";
import { isRoiSane, type HandRoi, type Vec2 } from "./hand-pipeline";

export const DETECTOR_RETRY_RESULTS = 6;

export interface HandCandidate {
  readonly roi: HandRoi;
  readonly centroid: Vec2;
}

interface TrackSlotState {
  readonly active: boolean;
  readonly presence: number;
  readonly lost: number;
  readonly centroid: Vec2 | undefined;
  readonly pendingRoi: HandRoi | undefined;
}

const createSlot = (): TrackSlotState => ({
  active: false,
  presence: 0,
  lost: 0,
  centroid: undefined,
  pendingRoi: undefined,
});

export function createHandTracker(options: {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}) {
  const slots = [createSlot(), createSlot()];
  let sinceDetector = Number.POSITIVE_INFINITY;
  let lostSinceDetector = false;

  const update = (index: number, values: Partial<TrackSlotState>) => {
    slots[index] = { ...slots[index]!, ...values };
  };
  const deactivate = (index: number) => {
    if (slots[index]!.active) lostSinceDetector = true;
    update(index, { active: false, pendingRoi: undefined });
  };

  return {
    get slots() {
      return slots.map((slot) => ({ ...slot }));
    },
    activeSlots() {
      return slots.flatMap((slot, index) => (slot.active ? [index] : []));
    },
    needsDetector() {
      if (slots.every((slot) => slot.active)) return false;
      if (slots.every((slot) => !slot.active)) return true;
      return lostSinceDetector || sinceDetector >= DETECTOR_RETRY_RESULTS;
    },
    acquire(candidates: readonly HandCandidate[]) {
      sinceDetector = 0;
      lostSinceDetector = false;
      const free = slots.flatMap((slot, index) => (slot.active ? [] : [index]));
      if (!free.length || !candidates.length) return [];

      const claimed = new Set<number>();
      for (const slot of slots) {
        if (!slot.active || !slot.centroid) continue;
        const nearest = nearestCandidate(slot.centroid, candidates, claimed);
        if (nearest !== undefined) claimed.add(nearest);
      }
      const available = candidates
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ index }) => !claimed.has(index));
      const assignment = assignByDistance(
        free.map((slot) => slots[slot]!.centroid),
        available.map(({ candidate }) => candidate.centroid)
      );

      const uploaded: number[] = [];
      for (let i = 0; i < assignment.length; i++) {
        const candidateIndex = assignment[i];
        if (candidateIndex === undefined) continue;
        const slot = free[i]!;
        const candidate = available[candidateIndex]!.candidate;
        if (
          !isRoiSane(
            candidate.roi,
            options.sourceWidth,
            options.sourceHeight,
            ROI_MIN_FRACTION,
            ROI_MAX_FRACTION
          )
        ) {
          continue;
        }
        update(slot, {
          active: true,
          presence: 0,
          lost: 0,
          centroid: candidate.centroid,
          pendingRoi: candidate.roi,
        });
        uploaded.push(slot);
      }
      return uploaded;
    },
    noteResult(slot: number, presence: number) {
      const state = slots[slot];
      if (!state) return;
      const threshold =
        state.lost === 0 && state.presence > 0 ? PRESENCE_STAY : PRESENCE_ENTER;
      const finite = Number.isFinite(presence);
      if (finite && presence >= threshold) {
        update(slot, {
          active: true,
          presence: Math.max(0, presence),
          lost: 0,
        });
        return;
      }
      const lost = state.lost + 1;
      update(slot, { presence: finite ? Math.max(0, presence) : 0, lost });
      if (lost >= TRACK_LOST_RESULTS) deactivate(slot);
    },
    noteMissing(slot: number) {
      const state = slots[slot];
      if (!state) return;
      const lost = state.lost + 1;
      update(slot, { presence: 0, lost });
      if (lost >= TRACK_LOST_RESULTS) deactivate(slot);
    },
    endFrame() {
      sinceDetector++;
    },
    clearPending(slot: number) {
      if (slots[slot]) update(slot, { pendingRoi: undefined });
    },
  };
}

export type HandTracker = ReturnType<typeof createHandTracker>;

function distance(a: Vec2 | undefined, b: Vec2 | undefined): number {
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Number.POSITIVE_INFINITY;
}

function nearestCandidate(
  centroid: Vec2,
  candidates: readonly HandCandidate[],
  claimed: ReadonlySet<number>
): number | undefined {
  let nearest: number | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < candidates.length; index++) {
    const candidateDistance = distance(centroid, candidates[index]?.centroid);
    if (!claimed.has(index) && candidateDistance < nearestDistance) {
      nearest = index;
      nearestDistance = candidateDistance;
    }
  }
  return nearest;
}

export function assignByDistance(
  slotCentroids: readonly (Vec2 | undefined)[],
  candidates: readonly Vec2[]
): readonly (number | undefined)[] {
  const result = slotCentroids.map(() => undefined as number | undefined);
  if (!result.length || !candidates.length) return result;
  if (slotCentroids.every((centroid) => centroid === undefined)) {
    const ordered = candidates
      .map((centroid, index) => ({ centroid, index }))
      .sort((a, b) => a.centroid.x - b.centroid.x);
    return result.map((_, index) => ordered[index]?.index);
  }
  result[0] = 0;
  if (result.length < 2 || candidates.length < 2) return result;
  result[1] = 1;
  const direct =
    finiteDistance(slotCentroids[0], candidates[0]) +
    finiteDistance(slotCentroids[1], candidates[1]);
  const swapped =
    finiteDistance(slotCentroids[0], candidates[1]) +
    finiteDistance(slotCentroids[1], candidates[0]);
  return swapped < direct ? [1, 0] : result;
}

function finiteDistance(a: Vec2 | undefined, b: Vec2 | undefined): number {
  const value = distance(a, b);
  return Number.isFinite(value) ? value : 0;
}
