import { describe, expect, test } from "vitest";
import { group, SceneNode } from "../../src/scene/nodes.ts";
import { composeMatrix } from "../../src/scene/transforms.ts";

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, precision = 5): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index++) expect(actual[index]).toBeCloseTo(expected[index]!, precision);
}

function caught(run: () => void): { code?: string; fix?: string } {
  try {
    run();
    return {};
  } catch (error) {
    return error as { code?: string; fix?: string };
  }
}

function worldForward(node: SceneNode): number[] {
  const world = node.worldMatrix;
  const x = -world[8]!, y = -world[9]!, z = -world[10]!;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

function direction(from: ArrayLike<number>, to: ArrayLike<number>): number[] {
  const x = to[0]! - from[0]!, y = to[1]! - from[1]!, z = to[2]! - from[2]!;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

describe("scene nodes", () => {
  test("group creates a material-independent transform node", () => {
    const node = group({ label: "root" });

    expect(node.kind).toBe("group");
    expect(node.label).toBe("root");
    expect(node.visible).toBe(true);
    expect(Array.from(node.worldMatrix)).toEqual([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
  });

  test("node arrays keep stable identity and constructor inputs are copied", () => {
    const position = [1, 2, 3];
    const quaternion = [0, 2, 0, 2];
    const scale = [2, 3, 4];
    const node = group({ position, quaternion, scale });
    const borrowed = {
      position: node.position,
      quaternion: node.quaternion,
      scale: node.scale,
      local: node.localMatrix,
      world: node.worldMatrix,
      worldPosition: node.worldPosition,
    };
    position[0] = quaternion[1] = scale[2] = 99;
    node.set({ position: [4, 5, 6] });

    expect(node.position).toBe(borrowed.position);
    expect(node.quaternion).toBe(borrowed.quaternion);
    expect(node.scale).toBe(borrowed.scale);
    expect(node.localMatrix).toBe(borrowed.local);
    expect(node.worldMatrix).toBe(borrowed.world);
    expect(node.worldPosition).toBe(borrowed.worldPosition);
    expectClose(node.position, [4, 5, 6]);
    expectClose(node.quaternion, [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    expectClose(node.scale, [2, 3, 4]);
  });

  test("set patches state atomically and its composition matches composeMatrix", () => {
    const node = group({ position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], scale: [2, 3, 4], label: "before" });
    node.set({ quaternion: [0, 3, 0, 3], visible: false });
    expectClose(node.localMatrix, composeMatrix({
      position: [1, 2, 3],
      quaternion: [0, 3, 0, 3],
      scale: [2, 3, 4],
    }, new Float32Array(16)));
    expect(node.visible).toBe(false);

    const before = {
      position: Array.from(node.position),
      quaternion: Array.from(node.quaternion),
      scale: Array.from(node.scale),
      label: node.label,
      visible: node.visible,
    };
    expect(caught(() => node.set({ position: [8, 9, 10], quaternion: [0, 0, 0, 0], label: "after", visible: true })).code)
      .toBe("VGPU-SCENE-VALUE");
    expect(Array.from(node.position)).toEqual(before.position);
    expect(Array.from(node.quaternion)).toEqual(before.quaternion);
    expect(Array.from(node.scale)).toEqual(before.scale);
    expect(node.label).toBe(before.label);
    expect(node.visible).toBe(before.visible);
  });

  test("accepted transform state is float32-rounded before the candidate matrix is validated", () => {
    const node = group();
    node.set({
      position: [1 + 2 ** -25, 2, 3],
      quaternion: [0.123456789, 0.234567891, 0.345678912, 0.901234567],
      scale: [3e38, 2, 3],
    });

    expect(() => node.localMatrix).not.toThrow();
    expectClose(node.localMatrix, composeMatrix({
      position: node.position,
      quaternion: node.quaternion,
      scale: node.scale,
    }, new Float32Array(16)));
  });

  test("constructor validation occurs before children are reparented", () => {
    const child = group({ label: "child" });
    const home = group({ children: [child] });

    expect(caught(() => group({ position: [Number.MAX_VALUE, 0, 0], children: [child] })).code).toBe("VGPU-SCENE-VALUE");
    expect(child.parent).toBe(home);
    expect(home.children).toEqual([child]);
  });

  test("add preflights every argument before reparenting and preserves local transforms", () => {
    const oldParent = group({ position: [1, 0, 0] });
    const nextParent = group({ position: [5, 0, 0] });
    const child = group({ position: [0, 2, 0] });
    oldParent.add(child);
    const local = Array.from(child.localMatrix);

    expect(caught(() => nextParent.add(child, nextParent)).code).toBe("VGPU-SCENE-CYCLE");
    expect(child.parent).toBe(oldParent);
    expect(nextParent.children).toHaveLength(0);
    expect(caught(() => nextParent.add(child, {} as SceneNode)).code).toBe("VGPU-SCENE-VALUE");
    expect(child.parent).toBe(oldParent);

    nextParent.add(child);
    expect(child.parent).toBe(nextParent);
    expect(Array.from(child.localMatrix)).toEqual(local);
    nextParent.remove(group(), child);
    expect(child.parent).toBeNull();
    expect(Array.from(child.localMatrix)).toEqual(local);
    child.removeFromParent();
    expect(child.parent).toBeNull();
  });

  test("deep invalidation, world reads, and traversal are iterative", () => {
    const root = group({ position: [1, 0, 0] });
    let leaf = root;
    const depth = 12_000;
    for (let index = 0; index < depth; index++) {
      const child = group({ position: [1, 0, 0] });
      leaf.add(child);
      leaf = child;
    }
    root.set({ position: [2, 0, 0] });

    expectClose(leaf.worldPosition, [depth + 2, 0, 0], 3);
    let visited = 0;
    root.traverse(() => visited++);
    expect(visited).toBe(depth + 1);
  });

  test("lookAt uses world targets through rotated nonuniform parents and rejects singular parents atomically", () => {
    const unparented = group({ position: [0.1, 0.2, 0.3], quaternion: [0, 1, 0, 1] });
    unparented.lookAt([0.1, 0.2, 0.3]);
    expectClose(unparented.quaternion, [0, 0, 0, 1]);

    const parent = group({ position: [1, -2, 4], rotation: [0.3, 0.7, -0.2], scale: [1, 3, 0.5] });
    const child = group({ position: [2, 1, 5] });
    parent.add(child);
    const target = [-4, 2, 1];
    child.lookAt(target, [0, 1, 0]);
    expectClose(worldForward(child), direction(child.worldPosition, target), 4);

    child.lookAt(child.worldPosition);
    expectClose(child.quaternion, [0, 0, 0, 1]);
    child.lookAt([0, 100, 0], [0, 1, 0]);
    for (const value of child.quaternion) expect(Number.isFinite(value)).toBe(true);

    const singularParent = group({ scale: [1, 0, 1] });
    const singularChild = group({ quaternion: [0, 1, 0, 1] });
    singularParent.add(singularChild);
    const quaternionBefore = Array.from(singularChild.quaternion);
    expect(caught(() => singularChild.lookAt([1, 2, 3])).code).toBe("VGPU-SPATIAL-SINGULAR");
    expect(Array.from(singularChild.quaternion)).toEqual(quaternionBefore);
    const singular = caught(() => singularChild.lookAt(singularChild.worldPosition));
    expect(singular.code).toBe("VGPU-SPATIAL-SINGULAR");
    expect(Array.from(singularChild.quaternion)).toEqual(quaternionBefore);
  });

  test("visible and label are metadata and do not suppress descendant transforms", () => {
    const parent = group({ position: [3, 0, 0], visible: false, label: "hidden" });
    const child = group({ position: [0, 4, 0] });
    parent.add(child);

    expectClose(child.worldPosition, [3, 4, 0]);
    expect(parent.visible).toBe(false);
    expect(parent.label).toBe("hidden");
  });
});
