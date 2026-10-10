import { mulberry32 } from "math/random";
import { describe, expect, it } from "vitest";

import {
  ABD_LIMIT,
  abductionFor,
  createLeg,
  FEMUR,
  HIP_OFFSET,
  kneeSide,
  legAngles,
  legRotations,
  REACH_MAX,
  REACH_MIN,
  resetLeg,
  SOLVE_THRESHOLD,
  solveLeg,
  TIBIA,
  type LegSpec,
} from "./leg";

type V = [number, number, number];
type Q = [number, number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const len = (a: readonly number[]) => Math.sqrt(dot(a, a));
const cross = (a: readonly number[], b: readonly number[]): V => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const rotate = (r: readonly number[], v: readonly number[]): V => {
  const [x, y, z, w] = r as Q;
  const t = cross([x, y, z], v).map((c) => 2 * c) as V;
  const c2 = cross([x, y, z], t);
  return [v[0]! + w * t[0] + c2[0], v[1]! + w * t[1] + c2[1], v[2]! + w * t[2] + c2[2]];
};

// The front-right leg: abduction pivot at the chassis corner, leg plane HIP_OFFSET outside it.
const RIGHT: LegSpec = { hip: [0.1, -0.04, 0.3], side: 1 };
const LEFT: LegSpec = { hip: [-0.1, -0.04, 0.3], side: -1 };
const femurBase: V = [0.1 + HIP_OFFSET, -0.04, 0.3];

/** A target in the unrolled leg plane at distance d from the femur base, `angle` forward of straight down. */
function planeTarget(d: number, angle: number): V {
  return [femurBase[0], femurBase[1] - d * Math.cos(angle), femurBase[2] + d * Math.sin(angle)];
}

describe("abducted two-bone leg", () => {
  const a = FEMUR;
  const b = TIBIA;
  for (const d of [REACH_MIN + 0.02, (a + b) / 2, 0.95 * REACH_MAX]) {
    it(`reaches an in-plane target at d = ${d.toFixed(3)} with the knee behind, matching the closed form`, () => {
      const leg = createLeg(RIGHT);
      const target = planeTarget(d, 0.25);
      const error = solveLeg(leg, target);
      expect(error).toBeLessThanOrEqual(SOLVE_THRESHOLD);
      expect(leg.abduction).toBeCloseTo(0, 9);
      expect(len(sub(leg.foot, target))).toBeLessThanOrEqual(SOLVE_THRESHOLD + 1e-12);
      expect(len(sub(leg.knee, leg.femurBase))).toBeCloseTo(a, 9);
      expect(len(sub(leg.foot, leg.knee))).toBeCloseTo(b, 9);
      // The hinge plane is fore-aft (x = const) and the knee bends backward.
      expect(Math.abs(leg.knee[0] - femurBase[0])).toBeLessThan(1e-9);
      expect(kneeSide(leg)).toBeLessThan(0);
      const t = (leg.knee[1] - femurBase[1]) / (target[1] - femurBase[1]);
      expect(leg.knee[2]).toBeLessThan(femurBase[2] + t * (target[2] - femurBase[2]));
      // Interior knee angle matches the law of cosines.
      const expected = Math.acos((a * a + b * b - d * d) / (2 * a * b));
      const femur = sub(leg.femurBase, leg.knee);
      const tibia = sub(leg.foot, leg.knee);
      const interior = Math.acos(dot(femur, tibia) / (len(femur) * len(tibia)));
      // A distance error δ along the reach moves the angle by δ·d/(a·b·sin θ); allow the threshold.
      const sensitivity = Math.max(1 / Math.min(a, b), d / (a * b * Math.sin(expected)));
      expect(Math.abs(interior - expected)).toBeLessThanOrEqual(SOLVE_THRESHOLD * sensitivity + 1e-9);
      // legAngles predicts the femur pitch the solver produced.
      const pitch = Math.atan2(-(leg.knee[2] - femurBase[2]), -(leg.knee[1] - femurBase[1]));
      expect(legAngles(RIGHT, target).pitch).toBeCloseTo(pitch, 3);
    });
  }

  it("clamps an out-of-reach target to REACH_MAX along the same direction", () => {
    const leg = createLeg(RIGHT);
    solveLeg(leg, planeTarget(1.5 * (a + b), 0.4));
    expect(len(sub(leg.goal, planeTarget(REACH_MAX, 0.4)))).toBeLessThan(1e-12);
    expect(len(sub(leg.foot, leg.goal))).toBeLessThanOrEqual(SOLVE_THRESHOLD);
    expect(kneeSide(leg)).toBeLessThan(0);
  });

  it("pushes a target inside the inner radius out to REACH_MIN", () => {
    const leg = createLeg(RIGHT);
    solveLeg(leg, planeTarget(0.3 * REACH_MIN, 0.2));
    expect(len(sub(leg.goal, femurBase))).toBeCloseTo(REACH_MIN, 12);
    expect([...leg.knee, ...leg.foot].every(Number.isFinite)).toBe(true);
    expect(len(sub(leg.knee, leg.femurBase))).toBeCloseTo(a, 9);
  });

  it("rejects non-finite targets and keeps the previous pose", () => {
    const leg = createLeg(RIGHT);
    solveLeg(leg, planeTarget(0.45, 0.1));
    const knee = [...leg.knee];
    const foot = [...leg.foot];
    expect(solveLeg(leg, [Number.NaN, 0, 0])).toBe(Infinity);
    expect(solveLeg(leg, [0, Number.POSITIVE_INFINITY, 0])).toBe(Infinity);
    expect([...leg.knee]).toEqual(knee);
    expect([...leg.foot]).toEqual(foot);
    expect(leg.rejected).toBe(2);
  });

  it("rolls the plane toward an outward target and keeps knee and foot in it", () => {
    const leg = createLeg(RIGHT);
    const target: V = [0.32, -0.46, 0.36];
    expect(solveLeg(leg, target)).toBeLessThanOrEqual(SOLVE_THRESHOLD);
    expect(leg.abduction).toBeGreaterThan(0.1);
    expect(leg.abduction).toBeCloseTo(abductionFor(RIGHT, target, 0), 12);
    // Hinge axis X' = (cos φ, sin φ, 0): the plane always holds the body's forward axis.
    expect(leg.axis[2]).toBe(0);
    expect(Math.abs(dot(sub(leg.knee, leg.femurBase), leg.axis))).toBeLessThan(1e-9);
    expect(Math.abs(dot(sub(leg.foot, leg.femurBase), leg.axis))).toBeLessThan(1e-9);
    expect(len(sub(leg.femurBase, RIGHT.hip))).toBeCloseTo(HIP_OFFSET, 12);
    expect(len(sub(leg.foot, target))).toBeLessThanOrEqual(SOLVE_THRESHOLD + 1e-12);
  });

  it("clamps abduction to ABD_LIMIT", () => {
    const leg = createLeg(RIGHT);
    solveLeg(leg, [0.9, -0.1, 0.3]);
    expect(leg.abduction).toBeCloseTo(ABD_LIMIT, 12);
    expect(kneeSide(leg)).toBeLessThan(0);
  });

  it("mirrors a left leg exactly", () => {
    const right = createLeg(RIGHT);
    const left = createLeg(LEFT);
    const target: V = [0.28, -0.44, 0.22];
    solveLeg(right, target);
    solveLeg(left, [-target[0], target[1], target[2]]);
    expect(left.abduction).toBeCloseTo(-right.abduction, 12);
    for (const [l, r] of [
      [left.knee, right.knee],
      [left.foot, right.foot],
    ] as const) {
      expect(l[0]).toBeCloseTo(-r[0], 6);
      expect(l[1]).toBeCloseTo(r[1], 6);
      expect(l[2]).toBeCloseTo(r[2], 6);
    }
    expect(kneeSide(left)).toBeLessThan(0);
  });

  it("keeps exact bone lengths and the knee behind through arbitrary targets", () => {
    const leg = createLeg(RIGHT);
    const random = mulberry32.create(5);
    const sample = () => mulberry32.sample(random);
    let worst = 0;
    let accepted = 0;
    for (let k = 0; k < 2000; k++) {
      const error = solveLeg(leg, [0.1 + (sample() * 2 - 1) * 0.6, -0.65 + sample() * 0.8, 0.3 + (sample() * 2 - 1) * 0.6]);
      worst = Math.max(
        worst,
        Math.abs(len(sub(leg.femurBase, RIGHT.hip)) - HIP_OFFSET),
        Math.abs(len(sub(leg.knee, leg.femurBase)) - FEMUR),
        Math.abs(len(sub(leg.foot, leg.knee)) - TIBIA),
      );
      if (Number.isFinite(error)) accepted++;
      expect(kneeSide(leg)).toBeLessThan(0);
      expect(Math.abs(leg.abduction)).toBeLessThanOrEqual(ABD_LIMIT);
    }
    // Targets above the hip or past the femur limits are rejected (≈ 11% of this box) and keep the pose.
    expect(accepted).toBeGreaterThan(1700);
    expect(accepted + leg.rejected).toBe(2000);
    expect(worst).toBeLessThan(1e-9);
  });

  it("is deterministic after reset regardless of history", () => {
    const leg = createLeg(RIGHT);
    const probe = planeTarget(0.5, 0.2);
    solveLeg(leg, probe);
    const fresh = [...leg.knee];
    for (let k = 0; k < 40; k++) solveLeg(leg, [0.15 + (k % 5) * 0.04, -0.35 - (k % 7) * 0.03, 0.2 + k * 0.006]);
    resetLeg(leg);
    solveLeg(leg, probe);
    expect([...leg.knee]).toEqual(fresh);
  });

  it("builds a Z-roll hip and segment frames whose X is the hinge and Y follows each bone", () => {
    const leg = createLeg(RIGHT);
    solveLeg(leg, [0.3, -0.45, 0.4]);
    const hip: Q = [0, 0, 0, 1];
    const femur: Q = [0, 0, 0, 1];
    const tibia: Q = [0, 0, 0, 1];
    legRotations(leg, hip, femur, tibia);
    expect(hip[0]).toBe(0);
    expect(hip[1]).toBe(0);
    expect(len(sub(rotate(hip, [1, 0, 0]), leg.axis))).toBeLessThan(1e-12);
    const femurDir = sub(leg.knee, leg.femurBase).map((c) => c / FEMUR);
    const tibiaDir = sub(leg.foot, leg.knee).map((c) => c / TIBIA);
    for (const [rotation, dir] of [
      [femur, femurDir],
      [tibia, tibiaDir],
    ] as const) {
      expect(len(sub(rotate(rotation, [1, 0, 0]), leg.axis))).toBeLessThan(1e-12);
      expect(len(sub(rotate(rotation, [0, 1, 0]), dir))).toBeLessThan(1e-9);
    }
  });
});
