import { describe, expect, test } from "vitest";
import { orbitControls, perspectiveCamera } from "../../../src/scene.ts";

type Listener = (event: unknown) => void;

class MockElement {
  listeners = new Map<string, Set<Listener>>();
  captured: number[] = [];
  released: number[] = [];

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  setPointerCapture(pointerId: number): void {
    this.captured.push(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.released.push(pointerId);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

function expectVec(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 4);
}

describe("orbitControls", () => {
  test("derives the initial spherical pose from the camera position", () => {
    const camera = perspectiveCamera({ fov: 45, position: [0, 0, 5], target: [0, 0, 0] });
    const controls = orbitControls(camera);
    expect(controls.distance).toBeCloseTo(5, 6);
    expect(controls.yaw).toBeCloseTo(0, 6);
    expect(controls.pitch).toBeCloseTo(0, 6);
  });

  test("set() jumps immediately and update() writes the camera transform", () => {
    const camera = perspectiveCamera({ fov: 45, position: [0, 0, 5], target: [0, 0, 0] });
    const controls = orbitControls(camera, { damping: 0 });

    controls.set({ yaw: Math.PI / 2 });
    expect(controls.update()).toBe(true);
    expectVec(camera.position, [5, 0, 0]);

    // -Z of the camera should face the target after update().
    const world = camera.worldMatrix;
    expectVec([-world[8]!, -world[9]!, -world[10]!], [-1, 0, 0]);

    expect(controls.update()).toBe(false);
  });

  test("damping eases toward the goal across updates", () => {
    const camera = perspectiveCamera({ fov: 45, position: [0, 0, 5], target: [0, 0, 0] });
    const controls = orbitControls(camera, { damping: 0.1, element: new MockElement() });
    controls.update();

    const element = new MockElement();
    const eased = orbitControls(camera, { damping: 0.1, element });
    element.emit("pointerdown", { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    element.emit("pointermove", { pointerId: 1, button: 0, clientX: 100, clientY: 0 });
    element.emit("pointerup", { pointerId: 1, button: 0, clientX: 100, clientY: 0 });

    eased.update(1 / 60);
    const partial = eased.yaw;
    expect(Math.abs(partial)).toBeGreaterThan(0);
    expect(Math.abs(partial)).toBeLessThan(0.5);

    for (let i = 0; i < 300; i++) eased.update(1 / 30);
    expect(eased.yaw).toBeCloseTo(-100 * 0.005, 3);
  });

  test("wheel zoom clamps to the configured distance range", () => {
    const camera = perspectiveCamera({ fov: 45, position: [0, 0, 5], target: [0, 0, 0] });
    const element = new MockElement();
    const controls = orbitControls(camera, { damping: 0, element, distance: { min: 2, max: 6 } });

    let prevented = 0;
    element.emit("wheel", { deltaY: 100000, preventDefault: () => { prevented++; } });
    controls.update();
    expect(prevented).toBe(1);
    expect(controls.distance).toBeCloseTo(6, 5);

    element.emit("wheel", { deltaY: -100000, preventDefault: () => { prevented++; } });
    controls.update();
    expect(controls.distance).toBeCloseTo(2, 5);
  });

  test("pitch is clamped away from the poles by default", () => {
    const camera = perspectiveCamera({ fov: 45, position: [0, 0, 5], target: [0, 0, 0] });
    const element = new MockElement();
    const controls = orbitControls(camera, { damping: 0, element });

    element.emit("pointerdown", { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    element.emit("pointermove", { pointerId: 1, button: 0, clientX: 0, clientY: 100000 });
    controls.update();

    expect(controls.pitch).toBeLessThan(Math.PI / 2);
    expect(controls.pitch).toBeGreaterThan(1.5);
  });

  test("orbits around a non-origin target", () => {
    const camera = perspectiveCamera({ fov: 45, position: [0, 1, 5], target: [0, 1, 0] });
    const controls = orbitControls(camera, { damping: 0, target: [0, 1, 0] });
    controls.set({ yaw: Math.PI });
    controls.update();
    expectVec(camera.position, [0, 1, -5]);
  });

  test("dispose removes every listener", () => {
    const camera = perspectiveCamera({ fov: 45, position: [0, 0, 5], target: [0, 0, 0] });
    const element = new MockElement();
    const controls = orbitControls(camera, { element });

    expect(element.listenerCount()).toBe(5);
    controls.dispose();
    expect(element.listenerCount()).toBe(0);
  });
});
