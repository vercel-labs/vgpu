import { describe, expect, it } from "vitest";

import { ABD_LIMIT, FEMUR, HIP_OFFSET, kneeSide, REACH_MAX, REACH_MIN, TIBIA } from "./leg";
import { createRobot, EDGE_MARGIN, FOOT_RADIUS, LEG_COUNT, LEG_SPECS, NEIGHBOURS, PAIR, placeRobot, RIDE_HEIGHT, stepRobot, toBody, type Robot } from "./robot";
import { CELLS, createTerrain, GRID, gridX, HALF, heightAt, sculpt, writeVertices, type Terrain } from "./terrain";

type V = [number, number, number];
const DT = 1 / 60;

/** v rotated by unit quaternion q = (x, y, z, w), written independently of math. */
function rotate(q: readonly number[], v: readonly number[]): V {
  const [x, y, z, w] = q as [number, number, number, number];
  const tx = 2 * (y * v[2]! - z * v[1]!);
  const ty = 2 * (z * v[0]! - x * v[2]!);
  const tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
}

function worldFoot(robot: Robot, leg: number): V {
  const local = rotate(robot.rotation, robot.legs[leg]!.foot);
  return [robot.position[0] + local[0], robot.position[1] + local[1], robot.position[2] + local[2]];
}

function planeTerrain(height: (x: number, z: number) => number): Terrain {
  const terrain = createTerrain(1);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) terrain.heights[j * GRID + i] = Math.fround(height(gridX(i), gridX(j)));
  }
  terrain.dirty = { i0: 0, j0: 0, i1: CELLS, j1: CELLS };
  writeVertices(terrain);
  return terrain;
}

function stand(terrain: Terrain, x: number, z: number, heading: number, steps: number): Robot {
  const robot = createRobot(0);
  placeRobot(robot, terrain, x, z, heading);
  for (let k = 0; k < steps; k++) stepRobot(robot, { terrain, dt: DT, pace: 1, steerX: 0, steerZ: 0 });
  return robot;
}

describe("body tilt follows the ground plane", () => {
  const cases: { name: string; gradient: [number, number] }[] = [
    { name: "y = 0.2x", gradient: [0.2, 0] },
    { name: "y = -0.2x", gradient: [-0.2, 0] },
    { name: "y = 0.2z", gradient: [0, 0.2] },
    { name: "y = 0.15x - 0.1z", gradient: [0.15, -0.1] },
    { name: "y = 0.2x + 0.1z", gradient: [0.2, 0.1] },
    { name: "y = 0.3x", gradient: [0.3, 0] },
  ];
  for (const { name, gradient } of cases) {
    for (const heading of [0, (2 * Math.PI) / 3, -1.1]) {
      it(`${name}, heading ${heading.toFixed(2)}: body up is the plane normal and forward keeps the heading`, () => {
        const [gx, gz] = gradient;
        const terrain = planeTerrain((x, z) => gx * x + gz * z);
        const robot = stand(terrain, 0.3, -0.2, heading, 240);
        const up = rotate(robot.rotation, [0, 1, 0]);
        const n = Math.hypot(gx, 1, gz);
        expect(up[0]).toBeCloseTo(-gx / n, 4);
        expect(up[1]).toBeCloseTo(1 / n, 4);
        expect(up[2]).toBeCloseTo(-gz / n, 4);
        // Forward stays in the heading's vertical plane.
        const forward = rotate(robot.rotation, [0, 0, 1]);
        expect(Math.atan2(forward[0], forward[2])).toBeCloseTo(heading, 6);
        // The body rides at RIDE_HEIGHT over the plane under its origin, measured along world y.
        expect(robot.position[1] - (gx * robot.position[0] + gz * robot.position[2])).toBeCloseTo(RIDE_HEIGHT, 3);
      });
    }
  }
});

describe("walking keeps contact", () => {
  function walk(seed: number, steps: number, steer: (k: number) => [number, number], edit?: (terrain: Terrain, k: number) => void) {
    const terrain = createTerrain(seed);
    const robot = createRobot(0);
    placeRobot(robot, terrain, -1.2, -0.8, 0.4);
    const start: V = [robot.position[0], robot.position[1], robot.position[2]];
    let worstFoot = 0;
    let worstDrift = 0;
    let worstLength = 0;
    let worstClearance = 0;
    let landings = 0;
    const previous = robot.feet.map((foot) => ({ planted: foot.planted, x: foot.position[0], z: foot.position[2] }));
    for (let k = 0; k < steps; k++) {
      edit?.(terrain, k);
      const [steerX, steerZ] = steer(k);
      stepRobot(robot, { terrain, dt: DT, pace: 1, steerX, steerZ });
      for (let leg = 0; leg < LEG_COUNT; leg++) {
        const foot = robot.feet[leg]!;
        const l = robot.legs[leg]!;
        const before = previous[leg]!;
        if (foot.planted) {
          // The solved foot, carried into world space, meets the desired foot.
          const actual = worldFoot(robot, leg);
          worstFoot = Math.max(worstFoot, Math.hypot(actual[0] - foot.position[0], actual[1] - foot.position[1], actual[2] - foot.position[2]));
          if (before.planted) worstDrift = Math.max(worstDrift, Math.hypot(foot.position[0] - before.x, foot.position[2] - before.z));
          else landings++;
        } else {
          worstClearance = Math.min(worstClearance, foot.position[1] - FOOT_RADIUS - heightAt(terrain, foot.position[0], foot.position[2]));
        }
        const femur = Math.hypot(l.knee[0] - l.femurBase[0], l.knee[1] - l.femurBase[1], l.knee[2] - l.femurBase[2]);
        const tibia = Math.hypot(l.foot[0] - l.knee[0], l.foot[1] - l.knee[1], l.foot[2] - l.knee[2]);
        worstLength = Math.max(worstLength, Math.abs(femur - FEMUR), Math.abs(tibia - TIBIA));
        expect([...l.knee, ...l.foot, ...foot.position].every(Number.isFinite)).toBe(true);
        before.planted = foot.planted;
        before.x = foot.position[0];
        before.z = foot.position[2];
      }
    }
    const travelled = Math.hypot(robot.position[0] - start[0], robot.position[2] - start[2]);
    return { robot, worstFoot, worstDrift, worstLength, worstClearance, landings, travelled };
  }

  it("walks straight with planted feet fixed in x/z and the solved feet on them", () => {
    const result = walk(3, 600, () => [Math.sin(0.4), Math.cos(0.4)]);
    expect(result.travelled).toBeGreaterThan(3);
    expect(result.landings).toBeGreaterThan(30);
    expect(result.worstDrift).toBe(0);
    expect(result.worstFoot).toBeLessThan(1e-3);
    expect(result.worstLength).toBeLessThan(1e-9);
    expect(result.worstClearance).toBeGreaterThanOrEqual(-1e-9);
    expect(result.robot.legs.every((leg) => leg.rejected === 0)).toBe(true);
  });

  it("lets the crowd's push move the body only as far as the planted feet can follow", () => {
    const terrain = planeTerrain(() => 0);
    const robot = stand(terrain, 0, 0, 0.3, 240);
    let worstFoot = 0;
    const shove = (pushX: number, steps: number) => {
      for (let k = 0; k < steps; k++) {
        stepRobot(robot, { terrain, dt: DT, pace: 1, steerX: 0, steerZ: 0, pushX, pushZ: 0 });
        for (let leg = 0; leg < LEG_COUNT; leg++) {
          const foot = robot.feet[leg]!;
          if (!foot.planted) continue;
          const actual = worldFoot(robot, leg);
          worstFoot = Math.max(worstFoot, Math.hypot(actual[0] - foot.position[0], actual[1] - foot.position[1], actual[2] - foot.position[2]));
        }
      }
    };
    // A shove far beyond a leg's reach is held back instead of tearing the body off its feet.
    const held = robot.held;
    shove(0.3, 30);
    expect(robot.held).toBeGreaterThan(held);
    expect(worstFoot).toBeLessThan(1e-3);
    // A gentle, steady push carries the body along and the gait steps after it.
    const start = robot.position[0];
    shove(0.01, 240);
    expect(robot.position[0] - start).toBeGreaterThan(0.5);
    expect(worstFoot).toBeLessThan(1e-3);
  });

  it("keeps contact while walking into the rim and along it", () => {
    const terrain = planeTerrain(() => 0);
    const robot = stand(terrain, HALF - 2, -2, Math.PI / 2, 120);
    let worstFoot = 0;
    let rim = 0;
    for (let k = 0; k < 900; k++) {
      // Straight into the +x rim, then press diagonally into it while walking along it.
      const [steerX, steerZ] = k < 300 ? [1, 0] : [0.7, 0.7];
      stepRobot(robot, { terrain, dt: DT, pace: 1, steerX, steerZ });
      rim = Math.max(rim, robot.position[0]);
      for (let leg = 0; leg < LEG_COUNT; leg++) {
        const foot = robot.feet[leg]!;
        if (!foot.planted) continue;
        const actual = worldFoot(robot, leg);
        worstFoot = Math.max(worstFoot, Math.hypot(actual[0] - foot.position[0], actual[1] - foot.position[1], actual[2] - foot.position[2]));
      }
    }
    expect(rim).toBeCloseTo(HALF - EDGE_MARGIN, 6);
    expect(worstFoot).toBeLessThan(1e-3);
  });

  it("turns in place and in arcs without losing contact", () => {
    const result = walk(4, 600, (k) => {
      const angle = 0.4 + k * 0.012;
      return [Math.sin(angle) * (k < 300 ? 1 : 0.15), Math.cos(angle) * (k < 300 ? 1 : 0.15)];
    });
    expect(result.worstDrift).toBe(0);
    expect(result.worstFoot).toBeLessThan(1e-3);
    expect(result.worstLength).toBeLessThan(1e-9);
  });

  it("keeps planted feet in x/z while the terrain is raised under them, and re-steps them", () => {
    let raised = 0;
    const result = walk(
      5,
      420,
      () => [0, 0],
      (terrain, k) => {
        // Raise a mound under the standing robot's right side for three seconds.
        if (k < 180 && sculpt(terrain, { x: -0.7, z: -0.9, radius: 0.7, rate: 0.6 }, DT)) raised++;
      },
    );
    expect(raised).toBeGreaterThan(100);
    expect(result.worstDrift).toBe(0);
    expect(result.worstFoot).toBeLessThan(1e-3);
    expect(result.worstLength).toBeLessThan(1e-9);
    // Feet whose ground moved were lifted and set down again.
    expect(result.landings).toBeGreaterThan(0);
  });

  it("is repeatable step for step", () => {
    const a = walk(6, 300, (k) => [Math.sin(k * 0.01), 1]);
    const b = walk(6, 300, (k) => [Math.sin(k * 0.01), 1]);
    expect([...a.robot.position, ...a.robot.rotation]).toEqual([...b.robot.position, ...b.robot.rotation]);
    expect(a.robot.feet.map((f) => [...f.position])).toEqual(b.robot.feet.map((f) => [...f.position]));
  });

  it("re-placing a walking robot leaves no swing or landing behind", () => {
    const { robot } = walk(7, 200, () => [0, 1]);
    const terrain = createTerrain(7);
    placeRobot(robot, terrain, 2, 1, -0.5);
    for (const foot of robot.feet) {
      expect(foot.planted).toBe(true);
      expect([...foot.start]).toEqual([...foot.position]);
      expect([...foot.landing]).toEqual([...foot.position]);
      expect(Math.hypot(foot.position[0] - 2, foot.position[2] - 1)).toBeLessThan(0.6);
    }
  });

  it("stays finite with fixed bone lengths when the feet are out of reach", () => {
    const terrain = createTerrain(2);
    const robot = createRobot(0);
    placeRobot(robot, terrain, 0, 0, 0);
    // Lift the body far above its feet: every target is beyond the reach band.
    robot.height.value += 2;
    stepRobot(robot, { terrain, dt: DT, pace: 1, steerX: 0, steerZ: 0 });
    for (const leg of robot.legs) {
      expect([...leg.knee, ...leg.foot].every(Number.isFinite)).toBe(true);
      expect(Math.hypot(leg.knee[0] - leg.femurBase[0], leg.knee[1] - leg.femurBase[1], leg.knee[2] - leg.femurBase[2])).toBeCloseTo(FEMUR, 9);
      expect(Math.hypot(leg.foot[0] - leg.knee[0], leg.foot[1] - leg.knee[1], leg.foot[2] - leg.knee[2])).toBeCloseTo(TIBIA, 9);
    }
  });
});

describe("quadruped trot", () => {
  it("has four corner legs paired on the diagonals, each lifting only when its neighbours are down", () => {
    expect(LEG_COUNT).toBe(4);
    for (let leg = 0; leg < LEG_COUNT; leg++) {
      const spec = LEG_SPECS[leg]!;
      for (const n of NEIGHBOURS[leg]!) {
        // A neighbour shares a side or an end, and belongs to the other trot pair.
        const other = LEG_SPECS[n]!;
        expect(spec.side === other.side || spec.hip[2] === other.hip[2]).toBe(true);
        expect(PAIR[n]).not.toBe(PAIR[leg]);
      }
    }
    // Pairs are diagonal: front-right with rear-left, rear-right with front-left.
    expect(PAIR[0]).toBe(PAIR[3]);
    expect(PAIR[1]).toBe(PAIR[2]);
    expect(PAIR[0]).not.toBe(PAIR[1]);
  });

  interface Gait {
    robot: Robot;
    fewestPlanted: number;
    pairViolations: number;
    worstSplay: number;
    worstAbduction: number;
    worstReach: [number, number];
    worstKnee: number;
    worstTilt: number;
    turned: number;
  }

  function trot(height: (x: number, z: number) => number, steps: number, steer: (k: number, robot: Robot) => [number, number], normal?: (x: number, z: number) => V): Gait {
    const terrain = planeTerrain(height);
    const robot = stand(terrain, -0.6, -0.6, 0.5, 120);
    const gait: Gait = { robot, fewestPlanted: 4, pairViolations: 0, worstSplay: 0, worstAbduction: 0, worstReach: [Infinity, 0], worstKnee: -Infinity, worstTilt: 0, turned: 0 };
    let heading = robot.heading.value;
    const local: V = [0, 0, 0];
    for (let k = 0; k < steps; k++) {
      const [steerX, steerZ] = steer(k, robot);
      stepRobot(robot, { terrain, dt: DT, pace: 1, steerX, steerZ });
      gait.turned += Math.abs(Math.atan2(Math.sin(robot.heading.value - heading), Math.cos(robot.heading.value - heading)));
      heading = robot.heading.value;
      let planted = 0;
      for (let leg = 0; leg < LEG_COUNT; leg++) {
        const foot = robot.feet[leg]!;
        const l = robot.legs[leg]!;
        gait.worstKnee = Math.max(gait.worstKnee, kneeSide(l));
        gait.worstAbduction = Math.max(gait.worstAbduction, Math.abs(l.abduction));
        if (!foot.planted) {
          if (NEIGHBOURS[leg]!.some((n) => !robot.feet[n]!.planted)) gait.pairViolations++;
          continue;
        }
        planted++;
        // Splay: how far a planted foot sits sideways from its unrolled leg plane, in body space.
        toBody(local, robot, foot.position);
        const spec = LEG_SPECS[leg]!;
        gait.worstSplay = Math.max(gait.worstSplay, Math.abs(local[0] - (spec.hip[0] + spec.side * HIP_OFFSET)));
        const reach = Math.hypot(l.foot[0] - l.femurBase[0], l.foot[1] - l.femurBase[1], l.foot[2] - l.femurBase[2]);
        gait.worstReach[0] = Math.min(gait.worstReach[0], reach);
        gait.worstReach[1] = Math.max(gait.worstReach[1], reach);
      }
      gait.fewestPlanted = Math.min(gait.fewestPlanted, planted);
      if (normal && k > 120) {
        const n = normal(robot.position[0], robot.position[2]);
        const up = rotate(robot.rotation, [0, 1, 0]);
        gait.worstTilt = Math.max(gait.worstTilt, Math.acos(Math.min(1, up[0] * n[0] + up[1] * n[1] + up[2] * n[2])));
      }
    }
    return gait;
  }

  it("walks on flat ground with a diagonal pair always down, knees behind and no splay", () => {
    const gait = trot(() => 0, 900, (k) => [Math.sin(0.5 + k * 0.002), Math.cos(0.5 + k * 0.002)]);
    expect(gait.robot.steps).toBe(1020);
    expect(gait.fewestPlanted).toBeGreaterThanOrEqual(2);
    expect(gait.pairViolations).toBe(0);
    expect(gait.worstKnee).toBeLessThan(0);
    expect(gait.worstAbduction).toBeLessThan(ABD_LIMIT);
    // Measured 0.034 m: planted feet stay under their leg plane while walking straight.
    expect(gait.worstSplay).toBeLessThan(0.06);
    expect(gait.worstReach[0]).toBeGreaterThan(REACH_MIN);
    expect(gait.worstReach[1]).toBeLessThan(REACH_MAX);
  });

  for (const [name, gx, gz] of [
    ["y = 0.2x + 0.1z", 0.2, 0.1],
    ["y = 0.3x", 0.3, 0],
  ] as const) {
    it(`keeps the plane tilt through every diagonal-pair swing on ${name}`, () => {
      const n = Math.hypot(gx, 1, gz);
      const gait = trot(
        (x, z) => gx * x + gz * z,
        720,
        () => [Math.sin(0.9), Math.cos(0.9)],
        () => [-gx / n, 1 / n, -gz / n],
      );
      expect(gait.fewestPlanted).toBe(2);
      // Measured ≈ 1.5e-4 rad: the pair fit keeps the plane gradient along both diagonals.
      expect(gait.worstTilt).toBeLessThan(0.01);
      expect(gait.robot.held).toBe(0);
      expect(gait.worstKnee).toBeLessThan(0);
      expect(gait.pairViolations).toBe(0);
    });
  }

  it("turns around 180° in place, stepping, without losing contact", () => {
    // Steer the opposite way of the starting heading, at a crawl.
    const goal = 0.5 + Math.PI;
    const gait = trot(() => 0, 600, () => [Math.sin(goal) * 0.05, Math.cos(goal) * 0.05]);
    const heading = gait.robot.heading.value;
    expect(Math.abs(Math.atan2(Math.sin(heading - 0.5 - Math.PI), Math.cos(heading - 0.5 - Math.PI)))).toBeLessThan(0.05);
    expect(gait.turned).toBeGreaterThan(Math.PI - 0.1);
    expect(gait.fewestPlanted).toBeGreaterThanOrEqual(2);
    expect(gait.worstKnee).toBeLessThan(0);
    expect(gait.worstAbduction).toBeLessThan(ABD_LIMIT);
  });
});
