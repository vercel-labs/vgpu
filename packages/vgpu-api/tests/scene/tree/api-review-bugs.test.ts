// Regression tests for the six confirmed bugs in docs/plans/scene-api-review.md §1.
// Each `describe` block maps 1:1 to a numbered finding so the review stays traceable.
import { describe, expect, test } from "vitest";
import {
  ambientLight,
  directionalLight,
  group,
  lambertMaterial,
  orbitControls,
  orthographicCamera,
  perspectiveCamera,
  unlitMaterial,
} from "../../../src/scene.ts";

type Listener = (event: unknown) => void;

class MockElement {
  listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function errorCode(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function errorWhere(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { where?: string }).where;
  }
  return undefined;
}

function expectVec(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 4);
}

/** World-space -Z of a node, normalized (the parent scale may denormalize the column). */
function worldForward(matrix: ArrayLike<number>): number[] {
  const x = -matrix[8]!, y = -matrix[9]!, z = -matrix[10]!;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

function directionTo(from: ArrayLike<number>, to: readonly number[]): number[] {
  const x = to[0]! - from[0]!, y = to[1]! - from[1]!, z = to[2]! - from[2]!;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

describe("api-review §1.1 — orbitControls with a parented node", () => {
  test("derives the initial pose from the world-space offset to the target", () => {
    const rig = group({ position: [10, 0, 0] });
    const camera = perspectiveCamera({ fov: 45, position: [0, 0, 5] });
    rig.add(camera);

    // World target is the rig origin: the camera sits 5 units away from it.
    const controls = orbitControls(camera, { damping: 0, target: [10, 0, 0] });
    expect(controls.distance).toBeCloseTo(5, 5);
    expect(controls.yaw).toBeCloseTo(0, 5);
    expect(controls.pitch).toBeCloseTo(0, 5);
  });

  test("orbits the world target instead of the parent-local one", () => {
    const rig = group({ position: [10, 0, 0] });
    const camera = perspectiveCamera({ fov: 45, position: [0, 0, 5] });
    rig.add(camera);
    const controls = orbitControls(camera, { damping: 0, target: [10, 0, 0] });

    controls.set({ yaw: Math.PI / 2 });
    controls.update();

    expectVec(camera.worldPosition, [15, 0, 0]);
    expectVec(worldForward(camera.worldMatrix), [-1, 0, 0]);
  });

  test("keeps orbiting the same world point when the rig moves", () => {
    const rig = group({ position: [0, 0, 0] });
    const camera = perspectiveCamera({ fov: 45, position: [0, 0, 4] });
    rig.add(camera);
    const controls = orbitControls(camera, { damping: 0, target: [0, 0, 0] });
    controls.update();
    expectVec(camera.worldPosition, [0, 0, 4]);

    rig.set({ position: [0, 3, 0] });
    controls.update();

    // The world target never moved, so neither should the camera's world pose.
    expectVec(camera.worldPosition, [0, 0, 4]);
    expectVec(worldForward(camera.worldMatrix), [0, 0, -1]);
  });

  test("a rotated rig does not skew the orbit", () => {
    const rig = group({ rotation: [0, Math.PI / 2, 0] });
    const camera = perspectiveCamera({ fov: 45, position: [0, 0, 6] });
    rig.add(camera);
    const controls = orbitControls(camera, { damping: 0, target: [0, 0, 0] });
    controls.set({ yaw: 0, distance: 6 });
    controls.update();

    expectVec(camera.worldPosition, [6, 0, 0]);
    expectVec(worldForward(camera.worldMatrix), [-1, 0, 0]);
  });
});

describe("api-review §1.2 — a NaN deltaTime must not poison the easing", () => {
  function draggedControls(): { controls: ReturnType<typeof orbitControls>; camera: ReturnType<typeof perspectiveCamera> } {
    const camera = perspectiveCamera({ fov: 45, position: [0, 0, 5] });
    const element = new MockElement();
    const controls = orbitControls(camera, { damping: 0.1, element });
    element.emit("pointerdown", { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    element.emit("pointermove", { pointerId: 1, button: 0, clientX: 100, clientY: 0 });
    element.emit("pointerup", { pointerId: 1, button: 0, clientX: 100, clientY: 0 });
    return { controls, camera };
  }

  test("update(NaN) keeps the state finite and still converges", () => {
    const { controls, camera } = draggedControls();

    controls.update(Number.NaN);

    expect(Number.isFinite(controls.yaw)).toBe(true);
    expect(Number.isFinite(controls.pitch)).toBe(true);
    expect(Number.isFinite(controls.distance)).toBe(true);
    expect(Number.isFinite(camera.position[0])).toBe(true);

    for (let i = 0; i < 500; i++) controls.update(1 / 60);
    expect(controls.yaw).toBeCloseTo(-100 * 0.005, 4);
  });

  test("update(Infinity) and update(undefined dt) stay finite", () => {
    const { controls } = draggedControls();
    controls.update(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(controls.yaw)).toBe(true);
    controls.update();
    expect(Number.isFinite(controls.yaw)).toBe(true);
  });

  test("set() rejects non-finite yaw/pitch/distance/target", () => {
    const camera = perspectiveCamera({ fov: 45, position: [0, 0, 5] });
    const controls = orbitControls(camera);
    expect(errorCode(() => controls.set({ yaw: Number.NaN }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(errorCode(() => controls.set({ pitch: Number.NaN }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(errorCode(() => controls.set({ distance: Number.POSITIVE_INFINITY }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(errorCode(() => controls.set({ target: [Number.NaN, 0, 0] }))).toBe("VGPU-SCENE-VALUE-INVALID");
    // Rejected inputs must not have been partially applied.
    expect(controls.yaw).toBe(0);
    expect(controls.distance).toBeCloseTo(5, 5);
  });
});

describe("api-review §1.3 — constructors validate before super() reparents children", () => {
  function orphanCheck(build: (child: ReturnType<typeof group>) => void): { code?: string; keptParent: boolean } {
    const child = group({ label: "child" });
    const home = group({ label: "home", children: [child] });
    const code = errorCode(() => build(child));
    return { code, keptParent: child.parent === home && home.children.length === 1 };
  }

  test("perspectiveCamera({ fov: 0 }) does not strand its children", () => {
    const { code, keptParent } = orphanCheck((child) => perspectiveCamera({ fov: 0, children: [child] }));
    expect(code).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(keptParent).toBe(true);
  });

  test("perspectiveCamera with an inverted near/far range does not strand its children", () => {
    const { code, keptParent } = orphanCheck((child) => perspectiveCamera({ fov: 45, near: 5, far: 1, children: [child] }));
    expect(code).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(keptParent).toBe(true);
  });

  test("perspectiveCamera with an invalid target does not strand its children", () => {
    const { code, keptParent } = orphanCheck((child) =>
      perspectiveCamera({ fov: 45, target: [0, 0] as never, children: [child] }));
    expect(code).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(keptParent).toBe(true);
  });

  test("orthographicCamera with an invalid up vector does not strand its children", () => {
    const { code, keptParent } = orphanCheck((child) =>
      orthographicCamera({ left: -1, right: 1, bottom: -1, top: 1, target: [0, 0, 0], up: [0, 1] as never, children: [child] }));
    expect(code).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(keptParent).toBe(true);
  });

  test("orthographicCamera with an invalid range does not strand its children", () => {
    const { code, keptParent } = orphanCheck((child) =>
      orthographicCamera({ left: -1, right: 1, bottom: -1, top: 1, near: 0, far: 10, children: [child] }));
    expect(code).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(keptParent).toBe(true);
  });

  test("directionalLight with a bad intensity/direction does not strand its children", () => {
    const intensity = orphanCheck((child) => directionalLight({ intensity: -1, children: [child] }));
    expect(intensity.code).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(intensity.keptParent).toBe(true);

    const direction = orphanCheck((child) => directionalLight({ direction: [0, -1] as never, children: [child] }));
    expect(direction.code).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(direction.keptParent).toBe(true);
  });

  test("ambientLight with a bad intensity does not strand its children", () => {
    const { code, keptParent } = orphanCheck((child) => ambientLight({ intensity: -1, children: [child] }));
    expect(code).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(keptParent).toBe(true);
  });
});

describe("api-review §1.4 — lookAt under a non-uniformly scaled parent", () => {
  test("world -Z points at the world target through a scaled parent", () => {
    const parent = group({ scale: [2, 1, 1] });
    const child = group({ position: [0, 0, 5] });
    parent.add(child);

    const target = [3, 0, 0] as const;
    child.lookAt(target);

    expectVec(worldForward(child.worldMatrix), directionTo(child.worldPosition, target));
  });

  test("works for a scaled and rotated parent", () => {
    const parent = group({ scale: [1, 3, 0.5], rotation: [0.3, 0.7, -0.2], position: [1, -2, 4] });
    const child = group({ position: [2, 1, 5] });
    parent.add(child);

    const target = [-4, 2, 1] as const;
    child.lookAt(target);

    expectVec(worldForward(child.worldMatrix), directionTo(child.worldPosition, target));
  });

  test("an unparented node is unaffected", () => {
    const node = group({ position: [0, 0, 5] });
    node.lookAt([0, 0, 0]);
    expectVec(node.quaternion, [0, 0, 0, 1]);
  });
});

describe("api-review §1.5 — material validation errors name the material", () => {
  test("color validation reports the material kind, not `undefined`", () => {
    expect(errorWhere(() => unlitMaterial({ color: [1, 1] as never }))).toBe("unlit.set");
    expect(errorWhere(() => lambertMaterial({ opacity: 2 }))).toBe("lambert.set");
    expect(errorWhere(() => unlitMaterial({ label: "sky", color: [1, 1] as never }))).toBe("sky.set");
  });

  test("kind is readable during construction and stays a literal afterwards", () => {
    expect(unlitMaterial().kind).toBe("unlit");
    expect(lambertMaterial().kind).toBe("lambert");
  });
});

describe("api-review §1.6 — degenerate aspect / ortho extents", () => {
  test("perspectiveCamera rejects a non-positive or non-finite aspect", () => {
    expect(errorCode(() => perspectiveCamera({ fov: 45, aspect: 0 }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(errorCode(() => perspectiveCamera({ fov: 45, aspect: -1 }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(errorCode(() => perspectiveCamera({ fov: 45, aspect: Number.NaN }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(errorCode(() => perspectiveCamera({ fov: 45 }).set({ aspect: 0 }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(errorCode(() => perspectiveCamera({ fov: 45 }).set({ aspect: Number.POSITIVE_INFINITY }))).toBe("VGPU-SCENE-VALUE-INVALID");
  });

  test("a rejected aspect leaves the previous projection intact", () => {
    const camera = perspectiveCamera({ fov: 45, aspect: 2 });
    const before = Array.from(camera.projection);
    expect(errorCode(() => camera.set({ aspect: 0 }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(camera.aspect).toBe(2);
    expect(Array.from(camera.projection)).toEqual(before);
  });

  test("orthographicCamera rejects empty extents", () => {
    expect(errorCode(() => orthographicCamera({ left: 1, right: 1, bottom: -1, top: 1 }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(errorCode(() => orthographicCamera({ left: -1, right: 1, bottom: 1, top: 1 }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(errorCode(() => orthographicCamera({ left: -1, right: Number.NaN, bottom: -1, top: 1 }))).toBe("VGPU-SCENE-VALUE-INVALID");
  });

  test("orthographicCamera.set() validates the resulting extents", () => {
    const camera = orthographicCamera({ left: -1, right: 1, bottom: -1, top: 1 });
    expect(errorCode(() => camera.set({ right: -1 }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(camera.right).toBe(1);
    expect(errorCode(() => camera.set({ top: -1 }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(camera.top).toBe(1);
    // A flipped-but-non-empty range stays legal (Y-flip is a real use case).
    camera.set({ bottom: 1, top: -1 });
    expect(camera.top).toBe(-1);
  });

  test("every projection entry stays finite for valid inputs", () => {
    const camera = perspectiveCamera({ fov: 45, aspect: 16 / 9 });
    for (const value of camera.projection) expect(Number.isFinite(value)).toBe(true);
  });
});
