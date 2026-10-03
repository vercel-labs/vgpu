import { describe, expect, it } from "vitest";
import { dolly, orbit, orbitRig, orthographic, pan, perspective, rigPose, smoothRig, viewMatrices, worldPerPixel, zoom } from "../../src/scene/camera-state.ts";

describe("external camera state", () => {
  it("creates independent rig state from copied values and defaults", () => {
    const target = new Float32Array([1, 2, 3]);
    const first = orbitRig({ target });
    const second = orbitRig();

    target[0] = 9;
    first.pan[1] = 4;

    expect(first).toEqual({
      target: new Float32Array([1, 2, 3]),
      pan: new Float32Array([0, 4, 0]),
      yaw: 0,
      pitch: 0,
      distance: 1,
    });
    expect(second).toEqual({
      target: new Float32Array([0, 0, 0]),
      pan: new Float32Array([0, 0, 0]),
      yaw: 0,
      pitch: 0,
      distance: 1,
    });
    expect(first.target).not.toBe(target);
    expect(first.target).not.toBe(second.target);
    expect(first.pan).not.toBe(second.pan);
  });

  it("applies orbit, pan, dolly and lens zoom with distinct semantics", () => {
    const rig = orbitRig({ target: [10, 0, 0], pan: [0, 0, 1], distance: 2 });
    const lens = { fov: 60, near: 0.1, far: 100 };

    expect(orbit(rig, Math.PI / 2, 0)).toBe(rig);
    expect(pan(rig, 1, 2)).toBe(rig);
    expect(dolly(rig, 2)).toBe(rig);
    expect(zoom(lens, 2)).toBe(lens);

    expect(rig.yaw).toBe(Math.PI / 2);
    expect(Array.from(rig.pan)).toEqual([expect.closeTo(0, 6), 2, expect.closeTo(0, 6)]);
    expect(rig.distance).toBe(4);
    expect(lens.fov).toBeCloseTo(32.2042275);

    const panThenOrbit = orbitRig();
    pan(panThenOrbit, 1, 0);
    orbit(panThenOrbit, Math.PI / 2, 0);
    const orbitThenPan = orbitRig();
    orbit(orbitThenPan, Math.PI / 2, 0);
    pan(orbitThenPan, 1, 0);
    expect(panThenOrbit.pan).toEqual(new Float32Array([1, 0, 0]));
    expect(Array.from(orbitThenPan.pan)).toEqual([
      expect.closeTo(0, 6),
      0,
      expect.closeTo(-1, 6),
    ]);
  });

  it("derives a world pose whose -Z axis looks at the target plus world-space pan", () => {
    const rig = orbitRig({ target: [10, 0, 0], pan: [0, 2, 0], yaw: Math.PI / 2, distance: 2 });
    const pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };

    expect(rigPose(rig, pose)).toBe(pose);
    expect(Array.from(pose.position)).toEqual([12, 2, expect.closeTo(0, 6)]);
    expect(Array.from(pose.quaternion)).toEqual([
      expect.closeTo(0, 6),
      expect.closeTo(Math.SQRT1_2, 6),
      expect.closeTo(0, 6),
      expect.closeTo(Math.SQRT1_2, 6),
    ]);

    rig.target[1] = 3;
    rigPose(rig, pose);
    expect(Array.from(pose.position)).toEqual([12, 5, expect.closeTo(0, 6)]);
    expect(rig.pan).toEqual(new Float32Array([0, 2, 0]));

    const pitched = orbitRig({ pitch: Math.PI / 6, distance: 2 });
    rigPose(pitched, pose);
    expect(Array.from(pose.position)).toEqual([
      expect.closeTo(0, 6),
      expect.closeTo(1, 6),
      expect.closeTo(Math.sqrt(3), 6),
    ]);
    expect(Array.from(pose.quaternion)).toEqual([
      expect.closeTo(-Math.sin(Math.PI / 12), 6),
      expect.closeTo(0, 6),
      expect.closeTo(0, 6),
      expect.closeTo(Math.cos(Math.PI / 12), 6),
    ]);
  });

  it("builds a vertical-FOV perspective matrix with WebGPU depth", () => {
    const projection = perspective({ fov: 90, near: 1, far: 11 }, 2, new Float32Array(16));

    expect(projectPoint(projection, [1, 1, -1])).toEqual([
      expect.closeTo(0.5, 6),
      expect.closeTo(1, 6),
      expect.closeTo(0, 6),
    ]);
    expect(projectPoint(projection, [0, 0, -11])[2]).toBeCloseTo(1);
  });

  it("builds a right-handed orthographic matrix with near zero allowed", () => {
    const projection = orthographic(
      { left: -2, right: 2, bottom: -1, top: 3, near: 0, far: 10 },
      new Float32Array(16),
    );

    expect(projectPoint(projection, [-2, -1, 0])).toEqual([
      expect.closeTo(-1, 6),
      expect.closeTo(-1, 6),
      expect.closeTo(0, 6),
    ]);
    expect(projectPoint(projection, [2, 3, -10])).toEqual([
      expect.closeTo(1, 6),
      expect.closeTo(1, 6),
      expect.closeTo(1, 6),
    ]);
  });

  it("normalizes a world-pose quaternion and accepts an arbitrary finite projection", () => {
    const pose = {
      position: new Float32Array([0, 0, 5]),
      quaternion: new Float32Array([0, 0, 0, 2]),
    };
    const projection = new Float32Array([
      2, 0, 0, 0,
      0, 3, 0, 0,
      0, 0, 4, 0,
      0, 0, 0, 1,
    ]);
    const out = { view: new Float32Array(16), viewProjection: new Float32Array(16) };

    expect(viewMatrices(pose, projection, out)).toBeUndefined();
    expectMatrixClose(out.view, [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, -5, 1,
    ]);
    expectMatrixClose(out.viewProjection, [
      2, 0, 0, 0,
      0, 3, 0, 0,
      0, 0, 4, 0,
      0, 0, -20, 1,
    ]);
    expect(pose.quaternion).toEqual(new Float32Array([0, 0, 0, 2]));

    const rig = orbitRig({ target: [1, 2, 3], pan: [4, -1, 2], yaw: 0.7, pitch: 0.3, distance: 5 });
    rigPose(rig, pose);
    viewMatrices(pose, projection, out);
    const pivotInView = transformPoint(out.view, [5, 1, 5]);
    expect(pivotInView).toEqual([
      expect.closeTo(0, 5),
      expect.closeTo(0, 5),
      expect.closeTo(-5, 5),
    ]);
  });

  it("smooths independent rig state linearly except for logarithmic distance", () => {
    const current = orbitRig({ distance: 1, yaw: 10 });
    const goal = orbitRig({ target: [10, 4, -2], pan: [2, 0, 6], yaw: 0, pitch: 0.4, distance: 9 });
    const goalSnapshot = {
      target: goal.target.slice(),
      pan: goal.pan.slice(),
      yaw: goal.yaw,
      pitch: goal.pitch,
      distance: goal.distance,
    };

    expect(smoothRig(current, goal, Math.log(2), { timeConstant: 1 })).toBe(current);
    expect(current.target).toEqual(new Float32Array([5, 2, -1]));
    expect(current.pan).toEqual(new Float32Array([1, 0, 3]));
    expect(current.yaw).toBeCloseTo(5);
    expect(current.pitch).toBeCloseTo(0.2);
    expect(current.distance).toBeCloseTo(3);
    expect(goal).toEqual(goalSnapshot);

    const unchanged = orbitRig({ target: [1, 2, 3], distance: 2 });
    expect(smoothRig(unchanged, goal, 0, { timeConstant: 1 })).toBe(unchanged);
    expect(unchanged).toEqual(orbitRig({ target: [1, 2, 3], distance: 2 }));
    smoothRig(unchanged, goal, 0, { timeConstant: 0 });
    expect(unchanged).toEqual(goal);
    expect(unchanged.target).not.toBe(goal.target);
    expect(unchanged.pan).not.toBe(goal.pan);
  });

  it("converts CSS-pixel motion to world units at the orbit distance", () => {
    expect(worldPerPixel(10, { fov: 60, near: 0.1, far: 100 }, 1000)).toBeCloseTo(
      2 * 10 * Math.tan(Math.PI / 6) / 1000,
    );
  });

  it("validates limits, direct state and finite candidates before mutating", () => {
    expect(caught(() => orbitRig({ target: [1, 2] })).code).toBe("VGPU-CAMERA-SIZE");
    expect(caught(() => orbitRig({ target: [3.5e38, 0, 0] })).code).toBe("VGPU-CAMERA-VALUE");

    const rig = orbitRig({ yaw: 1, pitch: 0.2, distance: 4 });
    const snapshot = { yaw: rig.yaw, pitch: rig.pitch, distance: rig.distance };
    const reversed = caught(() => orbit(rig, 2, 3, { minPitch: 0.5, maxPitch: -0.5 }));
    expect(reversed.code).toBe("VGPU-CAMERA-VALUE");
    expect(reversed.fix).toContain("ordered");
    expect({ yaw: rig.yaw, pitch: rig.pitch, distance: rig.distance }).toEqual(snapshot);
    expect(caught(() => orbit(rig, 0, 0, { minPitch: -Math.PI / 2 })).code).toBe("VGPU-CAMERA-VALUE");
    expect(caught(() => dolly(rig, 1, { minDistance: 5, maxDistance: 4 })).code).toBe("VGPU-CAMERA-VALUE");
    expect(caught(() => dolly(rig, 1, { maxDistance: -Infinity })).code).toBe("VGPU-CAMERA-VALUE");
    expect({ yaw: rig.yaw, pitch: rig.pitch, distance: rig.distance }).toEqual(snapshot);

    orbit(rig, 2, 1e300);
    expect(rig.yaw).toBe(3);
    expect(rig.pitch).toBeCloseTo(Math.PI / 2 - 1e-4);
    rig.pitch = Math.PI / 2;
    expect(caught(() => pan(rig, 1, 0)).code).toBe("VGPU-CAMERA-VALUE");
    rig.pitch = 0;

    const overflowYaw = orbitRig({ yaw: Number.MAX_VALUE });
    const yawError = caught(() => orbit(overflowYaw, Number.MAX_VALUE, 0));
    expect(yawError).toMatchObject({ code: "VGPU-CAMERA-VALUE", where: "orbit.result" });
    expect(overflowYaw.yaw).toBe(Number.MAX_VALUE);

    const invalidDistance = orbitRig({ pan: [1, 2, 3] });
    invalidDistance.distance = 0;
    expect(caught(() => pan(invalidDistance, 1, 1)).code).toBe("VGPU-CAMERA-VALUE");
    expect(invalidDistance.pan).toEqual(new Float32Array([1, 2, 3]));

    const overflowDistance = orbitRig({ distance: Number.MAX_VALUE });
    expect(caught(() => dolly(overflowDistance, 2)).code).toBe("VGPU-CAMERA-VALUE");
    expect(overflowDistance.distance).toBe(Number.MAX_VALUE);
    expect(caught(() => dolly(overflowDistance, 0)).code).toBe("VGPU-CAMERA-VALUE");

    const overflowPan = orbitRig({ pan: [3e38, 0, 0] });
    expect(caught(() => pan(overflowPan, 3e38, 0)).code).toBe("VGPU-CAMERA-VALUE");
    expect(overflowPan.pan).toEqual(new Float32Array([3e38, 0, 0]));

    const lens = { fov: 60, near: 0.1, far: 100 };
    expect(caught(() => zoom(lens, 2, { minFov: 100, maxFov: 10 })).code).toBe("VGPU-CAMERA-VALUE");
    expect(caught(() => zoom(lens, 2, { minFov: 0 })).code).toBe("VGPU-CAMERA-VALUE");
    expect(caught(() => zoom(lens, 2, { maxFov: 180 })).code).toBe("VGPU-CAMERA-VALUE");
    expect(caught(() => zoom(lens, Number.NaN)).code).toBe("VGPU-CAMERA-VALUE");
    expect(lens.fov).toBe(60);
  });

  it("clamps orbit, dolly and zoom to valid custom limits", () => {
    const rig = orbitRig({ pitch: 0.1, distance: 2 });
    orbit(rig, 4 * Math.PI, 1, { minPitch: -0.2, maxPitch: 0.3 });
    dolly(rig, 100, { minDistance: 1, maxDistance: 5 });
    expect(rig.yaw).toBe(4 * Math.PI);
    expect(rig.pitch).toBe(0.3);
    expect(rig.distance).toBe(5);

    dolly(rig, 0.01, { minDistance: 1, maxDistance: 5 });
    expect(rig.distance).toBe(1);

    const lens = { fov: 60, near: 0.1, far: 100 };
    zoom(lens, 100, { minFov: 20, maxFov: 80 });
    expect(lens.fov).toBe(20);
    zoom(lens, 0.01, { minFov: 20, maxFov: 80 });
    expect(lens.fov).toBe(80);

    const numericallyWideLens = { fov: 45, near: 0.1, far: 100 };
    zoom(numericallyWideLens, 1e-300, { minFov: 10, maxFov: 170 });
    expect(numericallyWideLens.fov).toBe(170);

    const defaultWideLens = { fov: 45, near: 0.1, far: 100 };
    zoom(defaultWideLens, Number.MIN_VALUE);
    expect(defaultWideLens.fov).toBe(180 - 1e-4);

    const defaultNarrowLens = { fov: 45, near: 0.1, far: 100 };
    zoom(defaultNarrowLens, Number.MAX_VALUE);
    expect(defaultNarrowLens.fov).toBe(1e-4);
  });

  it("stages supported input-output overlap and rejects conflicting output fields", () => {
    const poseStorage = new Float32Array(7);
    poseStorage.set([0, 0, 0, 9, 9, 9, 9]);
    const rig = orbitRig({ target: poseStorage.subarray(0, 3), distance: 2 });
    rig.target = poseStorage.subarray(0, 3);
    const overlappingPose = {
      position: poseStorage.subarray(0, 3),
      quaternion: poseStorage.subarray(3, 7),
    };
    rigPose(rig, overlappingPose);
    expect(overlappingPose.position).toEqual(new Float32Array([0, 0, 2]));
    expectMatrixClose(overlappingPose.quaternion, [0, 0, 0, 1]);

    const matrixStorage = new Float32Array(32);
    matrixStorage.set([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    const projectionAndView = matrixStorage.subarray(0, 16);
    const viewProjection = matrixStorage.subarray(16, 32);
    viewMatrices(
      { position: new Float32Array([0, 0, 3]), quaternion: new Float32Array([0, 0, 0, 1]) },
      projectionAndView,
      { view: projectionAndView, viewProjection },
    );
    expect(projectionAndView[14]).toBe(-3);
    expect(viewProjection[14]).toBe(-3);

    const poseConflictStorage = new Float32Array(6).fill(7);
    const poseConflict = {
      position: poseConflictStorage.subarray(0, 3),
      quaternion: poseConflictStorage.subarray(2, 6),
    };
    expect(caught(() => rigPose(orbitRig(), poseConflict)).code).toBe("VGPU-CAMERA-ALIAS");
    expect(poseConflictStorage).toEqual(new Float32Array(6).fill(7));

    const matrixConflictStorage = new Float32Array(24).fill(7);
    const matrices = {
      view: matrixConflictStorage.subarray(0, 16),
      viewProjection: matrixConflictStorage.subarray(8, 24),
    };
    expect(caught(() => viewMatrices(
      { position: new Float32Array(3), quaternion: new Float32Array([0, 0, 0, 1]) },
      new Float32Array(16),
      matrices,
    )).code).toBe("VGPU-CAMERA-ALIAS");
    expect(matrixConflictStorage).toEqual(new Float32Array(24).fill(7));
  });

  it("reports camera size/value failures and leaves matrix outputs unchanged", () => {
    expect(caught(() => rigPose(orbitRig(), {
      position: new Float32Array(2),
      quaternion: new Float32Array(4),
    })).code).toBe("VGPU-CAMERA-SIZE");
    expect(caught(() => rigPose(orbitRig(), {
      position: new Float32Array(3),
      quaternion: new Float32Array(3),
    })).code).toBe("VGPU-CAMERA-SIZE");
    expect(caught(() => perspective({ fov: 60, near: 0.1, far: 100 }, 1, new Float32Array(15))).code)
      .toBe("VGPU-CAMERA-SIZE");
    expect(caught(() => orthographic(
      { left: 1, right: 0, bottom: -1, top: 1, near: 0, far: 10 },
      new Float32Array(16),
    )).code).toBe("VGPU-CAMERA-VALUE");

    const perspectiveOut = new Float32Array(16).fill(7);
    expect(caught(() => perspective({ fov: Number.MIN_VALUE, near: 0.1, far: 100 }, 1, perspectiveOut)).code)
      .toBe("VGPU-CAMERA-VALUE");
    expect(perspectiveOut).toEqual(new Float32Array(16).fill(7));

    const orthographicOut = new Float32Array(16).fill(7);
    expect(caught(() => orthographic(
      { left: 0, right: Number.MIN_VALUE, bottom: -1, top: 1, near: 0, far: 10 },
      orthographicOut,
    )).code).toBe("VGPU-CAMERA-VALUE");
    expect(orthographicOut).toEqual(new Float32Array(16).fill(7));

    const view = new Float32Array(16).fill(7);
    const viewProjection = new Float32Array(16).fill(7);
    const identityPose = {
      position: new Float32Array(3),
      quaternion: new Float32Array([0, 0, 0, 1]),
    };
    expect(caught(() => viewMatrices(identityPose, new Float32Array(15), { view, viewProjection })).code)
      .toBe("VGPU-CAMERA-SIZE");
    expect(caught(() => viewMatrices(identityPose, new Float32Array(16), {
      view: new Float32Array(15),
      viewProjection,
    })).code).toBe("VGPU-CAMERA-SIZE");
    expect(caught(() => viewMatrices(identityPose, new Float32Array(16), {
      view,
      viewProjection: new Float32Array(15),
    })).code).toBe("VGPU-CAMERA-SIZE");
    expect(caught(() => viewMatrices(
      { position: new Float32Array(3), quaternion: new Float32Array(4) },
      new Float32Array(16),
      { view, viewProjection },
    )).code).toBe("VGPU-CAMERA-VALUE");
    expect(view).toEqual(new Float32Array(16).fill(7));
    expect(viewProjection).toEqual(new Float32Array(16).fill(7));
  });

  it("rejects smoothing aliases and invalid timing without partial updates", () => {
    for (const [dt, timeConstant] of [
      [-1, 1],
      [Number.NaN, 1],
      [Infinity, 1],
      [1, -1],
      [1, Number.NaN],
      [1, Infinity],
    ] as const) {
      const current = orbitRig({ target: [1, 2, 3], pan: [4, 5, 6], yaw: 2, pitch: 0.2, distance: 3 });
      const goal = orbitRig({ target: [7, 8, 9], pan: [10, 11, 12], yaw: 4, pitch: 0.4, distance: 6 });
      const before = cloneRig(current);
      expect(caught(() => smoothRig(current, goal, dt, { timeConstant })).code).toBe("VGPU-CAMERA-VALUE");
      expect(current).toEqual(before);
    }

    const writableStorage = new Float32Array(5);
    const overlappingCurrent = orbitRig();
    overlappingCurrent.target = writableStorage.subarray(0, 3);
    overlappingCurrent.pan = writableStorage.subarray(2, 5);
    const beforeWritableAlias = cloneRig(overlappingCurrent);
    const writableError = caught(() => smoothRig(overlappingCurrent, orbitRig(), 1, { timeConstant: 1 }));
    expect(writableError.code).toBe("VGPU-CAMERA-ALIAS");
    expect(writableError.fix).toContain("disjoint");
    expect(writableError.where).toBe("smoothRig.current.target");
    expect(overlappingCurrent).toEqual(beforeWritableAlias);

    const sharedStorage = new Float32Array(8);
    const current = orbitRig();
    const goal = orbitRig();
    current.target = sharedStorage.subarray(0, 3);
    goal.pan = sharedStorage.subarray(2, 5);
    const beforeCrossAlias = cloneRig(current);
    const crossAliasError = caught(() => smoothRig(current, goal, 1, { timeConstant: 1 }));
    expect(crossAliasError).toMatchObject({
      code: "VGPU-CAMERA-ALIAS",
      where: "smoothRig.current.target",
    });
    expect(current).toEqual(beforeCrossAlias);
    expect(caught(() => smoothRig(current, current, 1, { timeConstant: 1 })).code).toBe("VGPU-CAMERA-ALIAS");
  });
});

function projectPoint(matrix: ArrayLike<number>, point: readonly [number, number, number]): number[] {
  const [x, y, z] = point;
  const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
  return [
    (matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!) / w,
    (matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!) / w,
    (matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!) / w,
  ];
}

function transformPoint(matrix: ArrayLike<number>, point: readonly [number, number, number]): number[] {
  const [x, y, z] = point;
  return [
    matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
    matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
    matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
  ];
}

function expectMatrixClose(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index++) {
    expect(actual[index], `matrix index ${index}`).toBeCloseTo(expected[index]!);
  }
}

function caught(run: () => void): { code?: string; fix?: string; where?: string } {
  try {
    run();
    return {};
  } catch (error) {
    return error as { code?: string; fix?: string; where?: string };
  }
}

function cloneRig(rig: ReturnType<typeof orbitRig>): ReturnType<typeof orbitRig> {
  return {
    target: rig.target.slice(),
    pan: rig.pan.slice(),
    yaw: rig.yaw,
    pitch: rig.pitch,
    distance: rig.distance,
  };
}
