import { describe, expect, test } from "vitest";
import { box, group, mesh, normalMaterial, scene, unlitMaterial } from "../../../src/scene.ts";

function errorCode(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function expectVec(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 5);
}

describe("scene tree nodes", () => {
  test("factories tag kinds and apply options", () => {
    const child = group({ label: "child" });
    const root = scene({ children: [child] });
    const cube = mesh(box({ size: 1 }), unlitMaterial(), { position: [1, 2, 3] });

    expect(root.kind).toBe("scene");
    expect(child.kind).toBe("group");
    expect(cube.kind).toBe("mesh");
    expect(child.parent).toBe(root);
    expect(root.children).toEqual([child]);
    expectVec(cube.position, [1, 2, 3]);
  });

  test("mesh() without material defaults to normalMaterial", () => {
    const node = mesh(box());
    expect(node.material.kind).toBe(normalMaterial().kind);
    expect(node.geometry.kind).toBe("box");
  });

  test("set(rotation) rotates via intrinsic XYZ Euler angles", () => {
    const node = group();
    node.set({ rotation: [0, Math.PI / 2, 0] });
    const m = node.worldMatrix;
    // +X maps to -Z under a +90° yaw.
    expectVec([m[0]!, m[1]!, m[2]!], [0, 0, -1]);
    expectVec([m[8]!, m[9]!, m[10]!], [1, 0, 0]);
  });

  test("set(scale) accepts uniform numbers and per-axis vectors", () => {
    const uniform = group().set({ scale: 2 });
    expect(uniform.scale[0]).toBe(2);
    expect(uniform.scale[2]).toBe(2);
    expect(uniform.localMatrix[0]).toBe(2);

    const perAxis = group().set({ scale: [1, 2, 3] });
    expect(perAxis.localMatrix[5]).toBe(2);
    expect(perAxis.localMatrix[10]).toBe(3);
  });

  test("world matrices compose through the parent chain and stay identity-stable", () => {
    const parent = group({ position: [1, 0, 0] });
    const child = group({ position: [0, 1, 0] });
    parent.add(child);

    const world = child.worldMatrix;
    expectVec(child.worldPosition, [1, 1, 0]);

    parent.set({ position: [2, 0, 0] });
    expect(child.worldMatrix).toBe(world);
    expectVec(child.worldPosition, [2, 1, 0]);
  });

  test("parent rotation affects child world position", () => {
    const parent = group({ rotation: [0, Math.PI / 2, 0] });
    const child = group({ position: [1, 0, 0] });
    parent.add(child);
    expectVec(child.worldPosition, [0, 0, -1]);
  });

  test("add() reparents nodes and remove() detaches them", () => {
    const a = group({ label: "a" });
    const b = group({ label: "b" });
    const node = group({ position: [0, 0, 1] });

    a.add(node);
    expect(node.parent).toBe(a);
    b.add(node);
    expect(node.parent).toBe(b);
    expect(a.children).toHaveLength(0);

    b.remove(node);
    expect(node.parent).toBeNull();
    expectVec(node.worldPosition, [0, 0, 1]);
  });

  test("add() rejects cycles with VGPU-SCENE-CYCLE", () => {
    const root = scene();
    const middle = group();
    const leaf = group();
    root.add(middle);
    middle.add(leaf);

    expect(errorCode(() => leaf.add(root))).toBe("VGPU-SCENE-CYCLE");
    expect(errorCode(() => leaf.add(leaf))).toBe("VGPU-SCENE-CYCLE");
  });

  test("set() validates vector lengths with VGPU-SCENE-VALUE-INVALID", () => {
    const node = group();
    expect(errorCode(() => node.set({ position: [1, 2] as never }))).toBe("VGPU-SCENE-VALUE-INVALID");
    expect(errorCode(() => node.set({ quaternion: [0, 0, 1] as never }))).toBe("VGPU-SCENE-VALUE-INVALID");
  });

  test("traverse visits depth-first including the start node", () => {
    const root = scene({ label: "root" });
    const left = group({ label: "left" });
    const right = group({ label: "right" });
    const leaf = group({ label: "leaf" });
    root.add(left, right);
    left.add(leaf);

    const visited: (string | undefined)[] = [];
    root.traverse((node) => visited.push(node.label));
    expect(visited).toEqual(["root", "left", "leaf", "right"]);
  });

  test("lookAt orients -Z toward a world target, compensating parent transforms", () => {
    const free = group({ position: [0, 0, 5] });
    free.lookAt([0, 0, 0]);
    expectVec(free.quaternion, [0, 0, 0, 1]);

    const parent = group({ rotation: [0, Math.PI / 2, 0] });
    const child = group({ position: [0, 0, 5] });
    parent.add(child);
    child.lookAt([0, 0, 0]);

    const m = child.worldMatrix;
    // The world-space -Z axis of the child must point from its world position to the target.
    const forward = [-m[8]!, -m[9]!, -m[10]!];
    const position = child.worldPosition;
    const length = Math.hypot(position[0]!, position[1]!, position[2]!);
    expectVec(forward, [-position[0]! / length, -position[1]! / length, -position[2]! / length]);
  });
});
