import { describe, expect, it } from "vitest";

import {
  advance,
  ARRIVE,
  clearDestination,
  createColony,
  DEFAULT_SEED,
  FIXED_DT,
  MAX_CATCH_UP,
  MAX_ROBOTS,
  MIN_GAP,
  PRESETS,
  readStats,
  reset,
  RESUME,
  setCount,
  setDestination,
  setPreset,
  SLOT_GAP,
  SPACING,
  step,
  type Colony,
} from "./colony";
import { FEMUR, HIP_OFFSET, TIBIA } from "./leg";
import { EDGE_MARGIN, LEG_COUNT } from "./robot";
import { CELL, GRID, gridX, HALF, heightAt } from "./terrain";

function snapshot(colony: Colony): number[] {
  const values: number[] = [colony.steps, colony.count];
  for (let index = 0; index < colony.count; index++) {
    const robot = colony.robots[index]!;
    values.push(...robot.position, ...robot.rotation);
    for (const foot of robot.feet) values.push(...foot.position);
  }
  return values;
}

describe("clock", () => {
  it("runs whole fixed steps and carries the remainder", () => {
    const colony = createColony({ count: 1 });
    expect(advance(colony, FIXED_DT * 2.5)).toBe(2);
    expect(colony.accumulator).toBeCloseTo(FIXED_DT * 0.5, 9);
    expect(advance(colony, FIXED_DT * 0.6)).toBe(1);
    expect(colony.steps).toBe(3);
    expect(colony.time).toBeCloseTo(3 * FIXED_DT, 12);
  });

  it("caps catch-up after a long gap and drops the backlog", () => {
    const colony = createColony({ count: 1 });
    expect(advance(colony, 2)).toBe(MAX_CATCH_UP);
    expect(colony.accumulator).toBe(0);
    expect(colony.dropped).toBe(Math.floor(2 / FIXED_DT) - MAX_CATCH_UP);
    expect(advance(colony, FIXED_DT)).toBe(1);
  });

  it("does nothing while paused, keeps no backlog, and single-steps on demand", () => {
    const colony = createColony({ count: 3 });
    advance(colony, 0.5);
    colony.paused = true;
    const before = snapshot(colony);
    expect(advance(colony, 1)).toBe(0);
    expect(advance(colony, FIXED_DT * 3)).toBe(0);
    expect(snapshot(colony)).toEqual(before);
    step(colony);
    expect(colony.steps).toBe(before[0]! + 1);
    expect(snapshot(colony)).not.toEqual(before);
    colony.paused = false;
    // No backlog from the paused time.
    expect(advance(colony, FIXED_DT)).toBe(1);
  });

  it("ignores non-finite and negative elapsed time", () => {
    const colony = createColony({ count: 1 });
    expect(advance(colony, Number.NaN)).toBe(0);
    expect(advance(colony, -1)).toBe(0);
    expect(advance(colony, Number.POSITIVE_INFINITY)).toBe(MAX_CATCH_UP);
  });
});

describe("seeded reset", () => {
  it("replays the same colony for a seed, including wander and a destination", () => {
    const run = () => {
      const colony = createColony({ seed: 11, count: 12 });
      for (let k = 0; k < 240; k++) step(colony);
      setDestination(colony, 2, -1.5);
      for (let k = 0; k < 240; k++) step(colony);
      return snapshot(colony);
    };
    expect(run()).toEqual(run());
  });

  it("reset after edits returns to the fresh state", () => {
    const fresh = createColony({ seed: 5, count: 6 });
    const used = createColony({ seed: 5, count: 6 });
    used.brush.active = true;
    used.brush.x = 0.5;
    for (let k = 0; k < 120; k++) step(used);
    setCount(used, 20);
    reset(used, 5, 6);
    expect(snapshot(used)).toEqual(snapshot(fresh));
    expect(Array.from(used.terrain.heights)).toEqual(Array.from(fresh.terrain.heights));
  });

  it("different seeds differ", () => {
    expect(snapshot(createColony({ seed: 1, count: 4 }))).not.toEqual(snapshot(createColony({ seed: 2, count: 4 })));
  });
});

describe("population", () => {
  it("clamps counts and applies presets", () => {
    const colony = createColony({ count: 1 });
    setCount(colony, 0);
    expect(colony.count).toBe(1);
    setCount(colony, 500);
    expect(colony.count).toBe(MAX_ROBOTS);
    setCount(colony, Number.NaN);
    expect(colony.count).toBeGreaterThanOrEqual(1);
    for (const name of ["close-up", "colony", "stress"] as const) {
      setPreset(colony, name);
      expect(colony.count).toBe(PRESETS[name].count);
      expect(colony.robots.filter((robot) => robot.active)).toHaveLength(PRESETS[name].count);
    }
  });

  it("keeps existing robots in place when growing and only deactivates the tail when shrinking", () => {
    const colony = createColony({ count: 4 });
    for (let k = 0; k < 60; k++) step(colony);
    const before = colony.robots.slice(0, 4).map((robot) => [...robot.position]);
    setCount(colony, 10);
    expect(colony.robots.slice(0, 4).map((robot) => [...robot.position])).toEqual(before);
    setCount(colony, 2);
    expect(colony.robots[2]!.active).toBe(false);
    expect(colony.robots.slice(0, 2).map((robot) => [...robot.position])).toEqual(before.slice(0, 2));
  });

  it("spawns the stress preset on the tile and apart", () => {
    const colony = createColony({ count: MAX_ROBOTS });
    let closest = Infinity;
    for (let a = 0; a < colony.count; a++) {
      const robot = colony.robots[a]!;
      expect(Math.abs(robot.position[0])).toBeLessThanOrEqual(HALF - 1 + 1e-9);
      expect(Math.abs(robot.position[2])).toBeLessThanOrEqual(HALF - 1 + 1e-9);
      for (let b = a + 1; b < colony.count; b++) {
        const other = colony.robots[b]!;
        closest = Math.min(closest, Math.hypot(robot.position[0] - other.position[0], robot.position[2] - other.position[2]));
      }
    }
    expect(closest).toBeGreaterThan(SPACING * 0.85);
  });
});

describe("steering", () => {
  it("walks the colony to a destination and fans out around it", () => {
    const colony = createColony({ seed: 3, count: 6 });
    setDestination(colony, 2.5, 1.5);
    for (let k = 0; k < 60 * 25; k++) step(colony);
    const distances = colony.robots.slice(0, 6).map((robot) => Math.hypot(robot.position[0] - 2.5, robot.position[2] - 1.5));
    expect(Math.min(...distances)).toBeLessThan(0.4);
    expect(Math.max(...distances)).toBeLessThan(3.2);
    expect(colony.robots.slice(0, 6).filter((robot) => robot.arrived).length).toBeGreaterThanOrEqual(4);
    clearDestination(colony);
    expect(colony.destination.active).toBe(false);
  });

  it("keeps a crowd finite, on the tile and grounded while wandering and sculpting", () => {
    const colony = createColony({ seed: 9, count: MAX_ROBOTS });
    colony.brush.active = true;
    colony.brush.radius = 1.4;
    for (let k = 0; k < 600; k++) {
      colony.brush.mode = k % 240 < 120 ? "elevate" : "lower";
      colony.brush.x = Math.sin(k * 0.01) * 3;
      colony.brush.z = Math.cos(k * 0.013) * 3;
      step(colony);
    }
    for (let index = 0; index < colony.count; index++) {
      const robot = colony.robots[index]!;
      expect([...robot.position, ...robot.rotation].every(Number.isFinite)).toBe(true);
      expect(Math.abs(robot.position[0])).toBeLessThanOrEqual(HALF);
      expect(robot.position[1] - heightAt(colony.terrain, robot.position[0], robot.position[2])).toBeGreaterThan(0.12);
    }
    const stats = readStats(colony, { robots: 0, swinging: 0, meanSpeed: 0, worstResidual: 0, rejected: 0 });
    expect(stats.robots).toBe(MAX_ROBOTS);
    const ground = colony.robots.slice(0, colony.count).reduce((sum, robot) => sum + Math.hypot(robot.velocity[0], robot.velocity[1]), 0);
    expect(stats.meanSpeed).toBeCloseTo(ground / MAX_ROBOTS, 12);
    expect(stats.meanSpeed).toBeGreaterThan(0);
    // A foot shoved under the hip by a fast turn on a rising mound keeps its last pose for a
    // step or two (the solver's knee-side fallback); that stays rare.
    expect(stats.rejected).toBeLessThan(20);
    expect(stats.worstResidual).toBeLessThan(0.02);
    for (const robot of colony.robots.slice(0, colony.count)) {
      for (const leg of robot.legs) expect([...leg.knee, ...leg.foot].every(Number.isFinite)).toBe(true);
    }
  });

  it("keeps robots apart while wandering, at a destination and at rest, without shuffling a settled crowd", () => {
    const closest = (colony: Colony) => {
      let min = Infinity;
      for (let a = 0; a < colony.count; a++) {
        for (let b = a + 1; b < colony.count; b++) {
          const first = colony.robots[a]!.position;
          const second = colony.robots[b]!.position;
          min = Math.min(min, Math.hypot(first[0] - second[0], first[2] - second[2]));
        }
      }
      return min;
    };
    for (const count of [12, MAX_ROBOTS]) {
      const colony = createColony({ seed: DEFAULT_SEED, count });
      let wander = Infinity;
      for (let k = 0; k < 60 * 20; k++) {
        step(colony);
        if (k >= 30) wander = Math.min(wander, closest(colony));
      }
      setDestination(colony, 1.6, 1.2);
      let gathered = Infinity;
      for (let k = 0; k < 60 * 40; k++) {
        step(colony);
        gathered = Math.min(gathered, closest(colony));
      }
      // Shells touch below ~0.6; legs reach a neighbour's shell below ~0.9.
      expect(wander, `${count} wandering`).toBeGreaterThan(0.95);
      expect(gathered, `${count} at the destination`).toBeGreaterThan(0.95);
      if (count === 12) {
        // A gathered colony stands still: slots are farther apart than MIN_GAP, so the floor does
        // not keep nudging robots that arrived (the outermost slot can take longer to reach).
        const settled = colony.robots.slice(0, count).filter((robot) => robot.arrived);
        expect(settled.length).toBeGreaterThanOrEqual(10);
        const positions = settled.map((robot) => [robot.position[0], robot.position[2]]);
        for (let k = 0; k < 120; k++) step(colony);
        const travel = settled.map((robot, index) => Math.hypot(robot.position[0] - positions[index]![0]!, robot.position[2] - positions[index]![1]!));
        // Walking covers ~1.1 in 2 s; a settled robot only finishes braking or yields a few mm to
        // a late arrival passing by.
        expect(Math.max(...travel)).toBeLessThan(0.05);
      }
    }
  });

  it("separates coincident robots", () => {
    const colony = createColony({ seed: 2, count: 2 });
    colony.robots[1]!.position[0] = colony.robots[0]!.position[0];
    colony.robots[1]!.position[2] = colony.robots[0]!.position[2];
    for (let k = 0; k < 30; k++) step(colony);
    const [first, second] = colony.robots;
    expect(Math.hypot(first!.position[0] - second!.position[0], first!.position[2] - second!.position[2])).toBeGreaterThan(MIN_GAP * 0.9);
  });

  it("elevates and lowers the floor only under the brush, and the dogs ride the new height", () => {
    const colony = createColony({ seed: 4, count: 1 });
    const robot = colony.robots[0]!;
    const [x, z] = [robot.position[0], robot.position[2]];
    const before = Float32Array.from(colony.terrain.heights);
    const ground = heightAt(colony.terrain, x, z);
    colony.paused = true;
    Object.assign(colony.brush, { active: true, mode: "elevate", x, z, radius: 1, strength: 0.5 });
    for (let k = 0; k < 60; k++) step(colony);
    const raised = heightAt(colony.terrain, x, z);
    expect(raised).toBeGreaterThan(ground + 0.1);
    // Cells farther than the radius (plus one cell of interpolation) never move.
    let moved = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        if (colony.terrain.heights[k] === before[k]) continue;
        moved++;
        expect(Math.hypot(gridX(i) - x, gridX(j) - z)).toBeLessThan(1 + CELL);
      }
    }
    expect(moved).toBeGreaterThan(0);
    // The body follows the raised floor with every foot still planted on it.
    expect(robot.position[1] - raised).toBeGreaterThan(0.3);
    for (const foot of robot.feet) {
      if (foot.planted) expect(Math.abs(foot.position[1] - heightAt(colony.terrain, foot.position[0], foot.position[2]))).toBeLessThan(0.08);
    }
    colony.brush.mode = "lower";
    for (let k = 0; k < 120; k++) step(colony);
    expect(heightAt(colony.terrain, x, z)).toBeLessThan(raised - 0.1);
  });

  it("keeps every bone length through a stress walk without needing a rejected solve", () => {
    // seed 7 with 48 robots used to drive legs into the solver's rejection path during turns;
    // the gait-aware turn keeps every planted target solvable (leg.test.ts covers rejections).
    const colony = createColony({ seed: 7, count: MAX_ROBOTS });
    const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    let worst = 0;
    for (let k = 0; k < 720; k++) {
      if (k === 420) setDestination(colony, 1, -1);
      step(colony);
      for (let index = 0; index < colony.count; index++) {
        for (const leg of colony.robots[index]!.legs) {
          worst = Math.max(
            worst,
            Math.abs(distance(leg.spec.hip, leg.femurBase) - HIP_OFFSET),
            Math.abs(distance(leg.femurBase, leg.knee) - FEMUR),
            Math.abs(distance(leg.knee, leg.foot) - TIBIA),
          );
        }
      }
    }
    const rejected = colony.robots.reduce((sum, robot) => sum + robot.legs.reduce((legs, leg) => legs + leg.rejected, 0), 0);
    expect(rejected).toBe(0);
    expect(worst).toBeLessThan(1e-9);
  });
});

describe("planted feet in a turning colony", () => {
  // The solved foot, carried back to world space, must stay on the stored world contact of every
  // planted foot. The legs' own residual cannot see a body that turned a planted foot out of its
  // leg sector: the goal is clamped and solved exactly, but it is no longer where the foot is.
  const worldFoot = (out: number[], robot: Colony["robots"][number], leg: number) => {
    const [x, y, z, w] = robot.rotation;
    const p = robot.legs[leg]!.foot;
    const tx = 2 * (y * p[2] - z * p[1]);
    const ty = 2 * (z * p[0] - x * p[2]);
    const tz = 2 * (x * p[1] - y * p[0]);
    out[0] = p[0] + w * tx + y * tz - z * ty + robot.position[0];
    out[1] = p[1] + w * ty + z * tx - x * tz + robot.position[1];
    out[2] = p[2] + w * tz + x * ty - y * tx + robot.position[2];
    return out;
  };

  for (const count of [12, MAX_ROBOTS]) {
    it(`keeps the solved feet of ${count} robots on their planted contacts through wander and destination turns`, () => {
      const colony = createColony({ seed: DEFAULT_SEED, count });
      const world = [0, 0, 0];
      const headings = colony.robots.slice(0, count).map((robot) => robot.heading.value);
      let worst = 0;
      let turned = 0;
      let held = 0;
      const steps = 1500;
      for (let k = 0; k < steps; k++) {
        if (k === 600) setDestination(colony, 1, -1);
        if (k === 1050) setDestination(colony, -3, 2.5);
        step(colony);
        for (let index = 0; index < count; index++) {
          const robot = colony.robots[index]!;
          turned += Math.abs(robot.heading.value - headings[index]!);
          headings[index] = robot.heading.value;
          for (let leg = 0; leg < LEG_COUNT; leg++) {
            const foot = robot.feet[leg]!;
            if (!foot.planted) continue;
            worldFoot(world, robot, leg);
            worst = Math.max(worst, Math.hypot(world[0]! - foot.position[0], world[1]! - foot.position[1], world[2]! - foot.position[2]));
          }
        }
      }
      for (let index = 0; index < count; index++) held += colony.robots[index]!.held;
      // The robots really turned (more than a full turn each), and the guard rarely held one.
      expect(turned / count).toBeGreaterThan(2 * Math.PI);
      expect(held / (count * steps)).toBeLessThan(0.02);
      // The solver stops within 1e-4·(femur+tibia); 0.44 world units before the fix.
      expect(worst).toBeLessThan(1e-3);
    });
  }
});

describe("corner and edge destinations", () => {
  // Review round 2: slots folded onto each other at a corner and the crowd jammed short of them.
  // Arrival is measured on positions, not only on the flag: every robot must end on its own slot,
  // and no robot may count as arrived while a neighbour has shoved it off its slot.
  const plantedError = (robot: Colony["robots"][number]) => {
    const [x, y, z, w] = robot.rotation;
    let worst = 0;
    for (let leg = 0; leg < LEG_COUNT; leg++) {
      const foot = robot.feet[leg]!;
      if (!foot.planted) continue;
      const p = robot.legs[leg]!.foot;
      const tx = 2 * (y * p[2] - z * p[1]);
      const ty = 2 * (z * p[0] - x * p[2]);
      const tz = 2 * (x * p[1] - y * p[0]);
      const wx = p[0] + w * tx + y * tz - z * ty + robot.position[0];
      const wy = p[1] + w * ty + z * tx - x * tz + robot.position[1];
      const wz = p[2] + w * tz + x * ty - y * tx + robot.position[2];
      worst = Math.max(worst, Math.hypot(wx - foot.position[0], wy - foot.position[1], wz - foot.position[2]));
    }
    return worst;
  };
  const cases: [seed: number, count: number, x: number, z: number, seconds: number][] = [
    [DEFAULT_SEED, 12, -5.5, 5.5, 60],
    [DEFAULT_SEED, 12, 4, -6.5, 60],
    [DEFAULT_SEED, MAX_ROBOTS, 6.5, -6.5, 60],
    [DEFAULT_SEED, MAX_ROBOTS, -5, 4, 60],
    // A 48-robot formation reaching towards the rim (the EDGE_MARGIN regression itself is pinned by
    // robot.test.ts "keeps contact while walking into the rim and along it").
    [11, MAX_ROBOTS, 2, 2, 90],
  ];

  for (const [seed, count, x, z, seconds] of cases) {
    it(`brings ${count} robots (seed ${seed}) onto spaced slots around (${x}, ${z}) with feet planted`, () => {
      const colony = createColony({ seed, count });
      for (let k = 0; k < 600; k++) step(colony);
      setDestination(colony, x, z);
      step(colony);
      const robots = colony.robots.slice(0, count);
      let slotGap = Infinity;
      for (let a = 0; a < count; a++) {
        for (let b = a + 1; b < count; b++) {
          slotGap = Math.min(slotGap, Math.hypot(robots[a]!.goal[0] - robots[b]!.goal[0], robots[a]!.goal[1] - robots[b]!.goal[1]));
        }
      }
      // Before the fix the rim clamp stacked corner slots 0–0.19 apart.
      expect(slotGap).toBeGreaterThanOrEqual(SLOT_GAP - 1e-9);
      let restingOff = 0;
      let contact = 0;
      let rim = 0;
      for (let k = 0; k < 60 * seconds; k++) {
        step(colony);
        if (k % 6 !== 0) continue;
        for (const robot of robots) {
          if (robot.arrived) restingOff = Math.max(restingOff, Math.hypot(robot.goal[0] - robot.position[0], robot.goal[1] - robot.position[2]));
          contact = Math.max(contact, plantedError(robot));
          rim = Math.max(rim, Math.abs(robot.position[0]), Math.abs(robot.position[2]));
        }
      }
      const final = robots.map((robot) => Math.hypot(robot.goal[0] - robot.position[0], robot.goal[1] - robot.position[2]));
      let gap = Infinity;
      for (let a = 0; a < count; a++) {
        for (let b = a + 1; b < count; b++) {
          gap = Math.min(gap, Math.hypot(robots[a]!.position[0] - robots[b]!.position[0], robots[a]!.position[2] - robots[b]!.position[2]));
        }
      }
      expect(robots.every((robot) => robot.arrived)).toBe(true);
      // Every robot, arrived or not, ends on its own slot (a resting robot pushed past RESUME walks
      // back); one step of crowd push can carry it a little past RESUME before it wakes.
      expect(Math.max(...final)).toBeLessThanOrEqual(RESUME);
      expect(restingOff).toBeLessThan(RESUME + 0.05);
      expect(contact).toBeLessThan(1e-3);
      // Sanity check only: stepRobot clamps the body to exactly this bound, so it cannot fail; the
      // contact bound above and robot.test.ts's rim walk are what catch a rim regression.
      expect(rim).toBeLessThanOrEqual(HALF - EDGE_MARGIN + 1e-9);
      expect(gap).toBeGreaterThan(1);
    });
  }

  it("walks a resting robot back once it is pushed past RESUME, and ignores a smaller nudge", () => {
    const colony = createColony({ seed: DEFAULT_SEED, count: 12 });
    setDestination(colony, 0, 0);
    for (let k = 0; k < 60 * 40; k++) step(colony);
    const robot = colony.robots.slice(0, 12).find((candidate) => candidate.arrived && Math.hypot(candidate.goal[0], candidate.goal[1]) > 1)!;
    expect(robot).toBeDefined();
    // Displace it straight away from the destination, so no neighbour sits in the way back.
    const outward = Math.hypot(robot.goal[0], robot.goal[1]);
    const shove = (distance: number) => {
      robot.position[0] = robot.goal[0] + (robot.goal[0] / outward) * distance;
      robot.position[2] = robot.goal[1] + (robot.goal[1] / outward) * distance;
    };
    shove((ARRIVE + RESUME) / 2);
    for (let k = 0; k < 30; k++) step(colony);
    expect(robot.arrived).toBe(true);
    shove(RESUME + 0.3);
    step(colony);
    expect(robot.arrived).toBe(false);
    for (let k = 0; k < 60 * 10 && !robot.arrived; k++) step(colony);
    expect(robot.arrived).toBe(true);
    expect(Math.hypot(robot.goal[0] - robot.position[0], robot.goal[1] - robot.position[2])).toBeLessThan(ARRIVE);
  });

  // Two walkers each standing near the other's slot block each other nose to nose; without a swap
  // they wait for separation to slide them past.
  for (const [seed, x, z] of [[7, 0, 0], [3, 5, -6.5], [11, -6, 6]] as const) {
    it(`seed ${seed}: two walkers facing each other's slots at (${x}, ${z}) trade slots instead of blocking`, () => {
      const colony = createColony({ seed, count: 2 });
      for (let k = 0; k < 300; k++) step(colony);
      setDestination(colony, x, z);
      for (let k = 0; k < 60 * 40; k++) step(colony);
      expect(colony.robots[0]!.arrived && colony.robots[1]!.arrived).toBe(true);
      const slot = colony.slotOf[0]!;
      colony.slotOf[0] = colony.slotOf[1]!;
      colony.slotOf[1] = slot;
      const swaps = colony.swaps;
      step(colony);
      expect(colony.robots[0]!.arrived || colony.robots[1]!.arrived).toBe(false);
      for (let k = 0; k < 60 * 9 && !(colony.robots[0]!.arrived && colony.robots[1]!.arrived); k++) step(colony);
      expect(colony.swaps).toBeGreaterThan(swaps);
      for (const robot of colony.robots.slice(0, 2)) {
        expect(robot.arrived).toBe(true);
        // Settled within ARRIVE; the neighbour's MIN_GAP push may then nudge it inside RESUME.
        expect(Math.hypot(robot.goal[0] - robot.position[0], robot.goal[1] - robot.position[2])).toBeLessThan(RESUME);
      }
    });
  }
});
