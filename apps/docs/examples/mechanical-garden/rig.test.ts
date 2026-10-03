import { quat, vec3, type Quat, type Vec3 } from "math";
import { describe, expect, it, vi } from "vitest";

import { createColony, MAX_ROBOTS, step } from "./colony";
import { FEMUR, HIP_OFFSET, solveLeg, SOLVE_THRESHOLD, TIBIA } from "./leg";
import { createRobot, LEG_COUNT, LEG_SPECS, restFootLocal, toBody, type Robot } from "./robot";
import { carriesPayload, createRig, legRows, PART_MESHES, PER_ROBOT, poseRig, publishRig, ROWS_PER_ROBOT, rowOf, rowPosition, type Rig } from "./rig";

/** Independent float64 body transform: world = p + q·local. */
function bodyToWorld(out: Vec3, position: Vec3, rotation: Quat, local: Vec3): Vec3 {
  vec3.transformQuat(out, local, rotation);
  return vec3.add(out, out, position);
}

function localColumn(rig: Rig, row: number, column: number): number[] {
  return Array.from(rig.locals.subarray(row * 16 + column * 4, row * 16 + column * 4 + 3));
}

/** A robot posed at an arbitrary rotated, translated body with every foot solved onto `feet`. */
function posedRobot(position: Vec3, rotation: Quat, feet: Vec3[]): Robot {
  const robot = createRobot(0);
  robot.active = true;
  vec3.copy(robot.position, position);
  quat.copy(robot.rotation, rotation);
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    toBody(robot.targets[leg]!, robot, feet[leg]!);
    solveLeg(robot.legs[leg]!, robot.targets[leg]!);
  }
  return robot;
}

describe("rig hierarchy", () => {
  // Body = T(p)·Ry(2π/3)·Rx(0.15), the numerical review's assertion 2.
  const position: Vec3 = [0.6, 0.45, -0.35];
  const yaw: Quat = quat.setAxisAngle([0, 0, 0, 1], [0, 1, 0], (2 * Math.PI) / 3);
  const pitch: Quat = quat.setAxisAngle([0, 0, 0, 1], [1, 0, 0], 0.15);
  const rotation: Quat = quat.multiply([0, 0, 0, 1], yaw, pitch);
  const feet: Vec3[] = LEG_SPECS.map((spec, leg) => {
    // Rest feet, nudged differently per leg so no two legs share a pose.
    const local = restFootLocal([0, 0, 0], spec);
    local[0] += spec.side * 0.03 * leg;
    local[1] += 0.02 - leg * 0.012;
    local[2] += 0.05 - leg * 0.03;
    return bodyToWorld([0, 0, 0], position, rotation, local);
  });

  it("puts every foot row on its desired world foot and keeps bones as pure child offsets", () => {
    const robot = posedRobot(position, rotation, feet);
    const rig = createRig(1);
    poseRig(rig, [robot], 1);
    const world: Vec3 = [0, 0, 0];
    for (let leg = 0; leg < LEG_COUNT; leg++) {
      rowPosition(world, rig, rowOf(rig, "foot", 0, leg));
      expect(vec3.distance(world, feet[leg]!)).toBeLessThan(SOLVE_THRESHOLD + 1e-5);
      const rows = legRows(leg);
      // The hip row is a pure roll about the body's Z at the hip pivot: the body root is applied once.
      const hip = rowOf(rig, rows.hip, 0, rows.part);
      expect(localColumn(rig, hip, 3)).toEqual(Array.from(new Float32Array(LEG_SPECS[leg]!.hip)));
      const z = localColumn(rig, hip, 2);
      expect(Math.abs(z[0]!) + Math.abs(z[1]!) + Math.abs(z[2]! - 1)).toBeLessThan(1e-6);
      rowPosition(world, rig, hip);
      expect(vec3.distance(world, bodyToWorld([0, 0, 0], position, rotation, LEG_SPECS[leg]!.hip))).toBeLessThan(1e-5);
      // Child translations: the femur sits HIP_OFFSET out along the rolled X, then each bone along +Y.
      const translations: [number, Vec3][] = [
        [rowOf(rig, rows.femur, 0, rows.part), [LEG_SPECS[leg]!.side * HIP_OFFSET, 0, 0]],
        [rowOf(rig, "tibia", 0, leg), [0, FEMUR, 0]],
        [rowOf(rig, "foot", 0, leg), [0, TIBIA, 0]],
      ];
      for (const [row, expected] of translations) {
        const t = localColumn(rig, row, 3);
        expect(Math.abs(t[0]! - expected[0]) + Math.abs(t[1]! - expected[1]) + Math.abs(t[2]! - expected[2])).toBeLessThan(1e-6);
      }
      // Femur and tibia locals are pure hinges about their parent's X (the leg-plane normal).
      for (const row of [rowOf(rig, rows.femur, 0, rows.part), rowOf(rig, "tibia", 0, leg)]) {
        const x = localColumn(rig, row, 0);
        expect(Math.abs(x[0]! - 1) + Math.abs(x[1]!) + Math.abs(x[2]!)).toBeLessThan(1e-6);
      }
      // The knee row lands on the solved knee.
      rowPosition(world, rig, rowOf(rig, "tibia", 0, leg));
      expect(vec3.distance(world, bodyToWorld([0, 0, 0], position, rotation, robot.legs[leg]!.knee))).toBeLessThan(1e-5);
    }
  });

  it("lays out 18 rows per robot, hips and femurs split by side", () => {
    expect(ROWS_PER_ROBOT).toBe(18);
    expect(PER_ROBOT.hipRight + PER_ROBOT.hipLeft).toBe(LEG_COUNT);
    expect(PER_ROBOT.femurRight + PER_ROBOT.femurLeft).toBe(LEG_COUNT);
    for (let leg = 0; leg < LEG_COUNT; leg++) expect(legRows(leg).hip).toBe(LEG_SPECS[leg]!.side === 1 ? "hipRight" : "hipLeft");
  });

  it("keeps world feet fixed when the body yaws, with body-local targets rotated by −Δψ", () => {
    const before = posedRobot(position, rotation, feet);
    const turned: Quat = quat.multiply([0, 0, 0, 1], quat.setAxisAngle([0, 0, 0, 1], [0, 1, 0], 0.4), rotation);
    const after = posedRobot(position, turned, feet);
    const rig = createRig(2);
    poseRig(rig, [before, after], 2);
    const back: Quat = quat.setAxisAngle([0, 0, 0, 1], [0, 1, 0], -0.4);
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    for (let leg = 0; leg < LEG_COUNT; leg++) {
      rowPosition(a, rig, rowOf(rig, "foot", 0, leg));
      rowPosition(b, rig, rowOf(rig, "foot", 1, leg));
      expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeLessThan(2 * SOLVE_THRESHOLD + 1e-5);
      expect(vec3.distance(b, feet[leg]!)).toBeLessThan(SOLVE_THRESHOLD + 1e-5);
      // Body-local target after the yaw = Ry(−Δψ)·target before, in the body's own frame: compare
      // through the pitch, which the yaw is applied outside of.
      const expected = vec3.transformQuat([0, 0, 0], feet[leg]!.map((v, k) => v - position[k]!) as Vec3, quat.invert([0, 0, 0, 1], turned));
      expect(vec3.distance(after.targets[leg]!, expected)).toBeLessThan(1e-12);
      const viaBefore = vec3.transformQuat([0, 0, 0], before.targets[leg]!, rotation);
      vec3.transformQuat(viaBefore, viaBefore, back);
      vec3.transformQuat(viaBefore, viaBefore, quat.invert([0, 0, 0, 1], rotation));
      expect(vec3.distance(after.targets[leg]!, viaBefore)).toBeLessThan(1e-12);
    }
  });

  it("matches the simulation's world feet across a walking, turning colony", () => {
    const colony = createColony({ seed: 7, count: 12 });
    const rig = createRig(MAX_ROBOTS);
    const expected: Vec3 = [0, 0, 0];
    const actual: Vec3 = [0, 0, 0];
    let worst = 0;
    for (let k = 0; k < 240; k++) {
      step(colony);
      if (k % 20 !== 19) continue;
      poseRig(rig, colony.robots, colony.count);
      for (let index = 0; index < colony.count; index++) {
        const robot = colony.robots[index]!;
        for (let leg = 0; leg < LEG_COUNT; leg++) {
          bodyToWorld(expected, robot.position, robot.rotation, robot.legs[leg]!.foot);
          rowPosition(actual, rig, rowOf(rig, "foot", index, leg));
          worst = Math.max(worst, vec3.distance(expected, actual) / Math.max(1, vec3.length(expected)));
          bodyToWorld(expected, robot.position, robot.rotation, robot.legs[leg]!.knee);
          rowPosition(actual, rig, rowOf(rig, "tibia", index, leg));
          worst = Math.max(worst, vec3.distance(expected, actual) / Math.max(1, vec3.length(expected)));
        }
      }
    }
    expect(worst).toBeLessThan(1e-5);
    expect(rig.skipped).toBe(0);
  });
});

describe("rig publication", () => {
  it("grows and releases tail handles without moving earlier slots", () => {
    const colony = createColony({ seed: 2, count: 5 });
    const rig = createRig(MAX_ROBOTS);
    poseRig(rig, colony.robots, 5);
    publishRig(rig, colony.robots, 5);
    for (const mesh of PART_MESHES) {
      if (mesh !== "payload") expect(rig.collections[mesh].count).toBe(5 * PER_ROBOT[mesh]);
    }
    const kept = rig.ids.femurRight.slice(0, 2 * PER_ROBOT.femurRight);
    publishRig(rig, colony.robots, 2);
    expect(rig.collections.femurRight.count).toBe(kept.length);
    expect(rig.ids.femurRight).toEqual(kept);
    kept.forEach((id, slot) => expect(rig.collections.femurRight.slotOf(id)).toBe(slot));
    publishRig(rig, colony.robots, MAX_ROBOTS);
    expect(rig.collections.foot.count).toBe(MAX_ROBOTS * LEG_COUNT);
    expect(rig.collections.femurRight.slotOf(kept.at(-1)!)).toBe(kept.length - 1);
  });

  it("publishes a payload only for carriers, at the carrier's payload row", () => {
    const colony = createColony({ seed: 2, count: 12 });
    const rig = createRig(12);
    poseRig(rig, colony.robots, 12);
    publishRig(rig, colony.robots, 12);
    const carriers = colony.robots.slice(0, 12).flatMap((robot, index) => (carriesPayload(robot) ? [index] : []));
    expect(carriers.length).toBe(4);
    expect(rig.collections.payload.count).toBe(carriers.length);
    expect(rig.payloadRobots).toEqual(carriers);
    publishRig(rig, colony.robots, 3);
    expect(rig.payloadRobots).toEqual(carriers.filter((index) => index < 3));
    expect(rig.collections.payload.count).toBe(rig.payloadRobots.length);
  });

  it("rewrites part styles only when a robot's palette changes", () => {
    const colony = createColony({ seed: 2, count: 2 });
    const rig = createRig(2);
    publishRig(rig, colony.robots, 2);
    const set = vi.spyOn(rig.collections.shell, "set");
    publishRig(rig, colony.robots, 2);
    expect(set).not.toHaveBeenCalled();
    colony.robots[0]!.palette = 1 - colony.robots[0]!.palette;
    publishRig(rig, colony.robots, 2);
    expect(set).toHaveBeenCalledTimes(PER_ROBOT.shell);
  });

  it("keeps the previous pose when a robot's state is non-finite instead of throwing", () => {
    const colony = createColony({ seed: 2, count: 2 });
    const rig = createRig(2);
    poseRig(rig, colony.robots, 2);
    const shell = Array.from(rig.worlds.subarray(0, 16));
    colony.robots[0]!.position[0] = Number.NaN;
    poseRig(rig, colony.robots, 2);
    expect(rig.skipped).toBe(1);
    expect(Array.from(rig.worlds.subarray(0, 16))).toEqual(shell);
    expect(() => publishRig(rig, colony.robots, 2)).not.toThrow();
  });
});
