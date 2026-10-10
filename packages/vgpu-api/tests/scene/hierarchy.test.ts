import { describe, expect, test } from "vitest";
import { evaluateHierarchy, hierarchyOrder } from "../../src/scene/hierarchy.ts";
import { group } from "../../src/scene/nodes.ts";
import { composeMatrix } from "../../src/scene/transforms.ts";

function caught(run: () => void): { code?: string; fix?: string } {
  try {
    run();
    return {};
  } catch (error) {
    return error as { code?: string; fix?: string };
  }
}

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, precision = 5): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index++) expect(actual[index]).toBeCloseTo(expected[index]!, precision);
}

function matrices(...values: Parameters<typeof composeMatrix>[0][]): Float32Array {
  const result = new Float32Array(values.length * 16);
  for (let row = 0; row < values.length; row++) composeMatrix(values[row]!, result.subarray(row * 16, row * 16 + 16));
  return result;
}

describe("dense hierarchy evaluation", () => {
  test("empty hierarchies compile and evaluate", () => {
    const parents = new Int32Array(0);
    const order = hierarchyOrder(parents);

    expect(order.size).toBe(0);
    expect(evaluateHierarchy({
      order,
      parents,
      locals: new Float32Array(0),
      worlds: new Float32Array(0),
    })).toBe(0);
  });

  test("compilation produces a complete parent-before-child traversal for reordered rows and roots", () => {
    const parents = new Int32Array([2, -1, 1, -1, 3]);
    const locals = matrices(
      { position: [1, 0, 0] },
      { position: [0, 10, 0] },
      { position: [0, 0, 2] },
      { position: [-4, 0, 0] },
      { position: [0, 5, 0] },
    );
    const worlds = new Float32Array(5 * 16);

    expect(evaluateHierarchy({ order: hierarchyOrder(parents), parents, locals, worlds })).toBe(5);
    expectClose(worlds.subarray(0, 16), matrices({ position: [1, 10, 2] }));
    expectClose(worlds.subarray(16, 32), matrices({ position: [0, 10, 0] }));
    expectClose(worlds.subarray(32, 48), matrices({ position: [0, 10, 2] }));
    expectClose(worlds.subarray(48, 64), matrices({ position: [-4, 0, 0] }));
    expectClose(worlds.subarray(64, 80), matrices({ position: [-4, 5, 0] }));
  });

  test("changed rows propagate to descendants while unrelated branches stay untouched", () => {
    const parents = new Int32Array([-1, 0, 1, -1, 3]);
    const order = hierarchyOrder(parents);
    const locals = matrices(
      { position: [1, 0, 0] }, { position: [0, 2, 0] }, { position: [0, 0, 3] },
      { position: [4, 0, 0] }, { position: [0, 5, 0] },
    );
    const worlds = new Float32Array(80);
    const updated = new Uint8Array(5).fill(9);
    expect(evaluateHierarchy({ order, parents, locals, worlds, updated })).toBe(5);
    expect(Array.from(updated)).toEqual([1, 1, 1, 1, 1]);
    const unrelatedBefore = Array.from(worlds.subarray(48, 80));
    const changed = new Uint8Array([0, 1, 0, 0, 0]);
    composeMatrix({ position: [0, 7, 0] }, locals.subarray(16, 32));

    expect(evaluateHierarchy({ order, parents, locals, worlds, changed, updated })).toBe(2);
    expect(Array.from(updated)).toEqual([0, 1, 1, 0, 0]);
    expect(Array.from(changed)).toEqual([0, 1, 0, 0, 0]);
    expect(Array.from(worlds.subarray(48, 80))).toEqual(unrelatedBefore);
    expectClose(worlds.subarray(32, 48), matrices({ position: [1, 7, 3] }));
  });

  test("updated is optional, stale flags are overwritten, and a new output requires an explicit full evaluation", () => {
    const parents = new Int32Array([-1, 0]);
    const order = hierarchyOrder(parents);
    const locals = matrices({ position: [2, 0, 0] }, { position: [0, 3, 0] });
    const first = new Float32Array(32);
    expect(evaluateHierarchy({ order, parents, locals, worlds: first })).toBe(2);

    const replacement = new Float32Array(32).fill(11);
    const clean = new Uint8Array(2);
    const updated = new Uint8Array([7, 7]);
    expect(evaluateHierarchy({ order, parents, locals, worlds: replacement, changed: clean, updated })).toBe(0);
    expect(Array.from(updated)).toEqual([0, 0]);
    expect(Array.from(replacement)).toEqual(new Array(32).fill(11));
    expect(evaluateHierarchy({ order, parents, locals, worlds: replacement, updated })).toBe(2);
    expectClose(replacement, first);
  });

  test("mutated topology requires a rebuilt token and preflight leaves outputs untouched", () => {
    const parents = new Int32Array([-1, 0]);
    const order = hierarchyOrder(parents);
    const locals = matrices({}, { position: [1, 0, 0] });
    const worlds = new Float32Array(32).fill(6);
    const updated = new Uint8Array([8, 8]);
    parents[1] = -1;

    expect(caught(() => evaluateHierarchy({ order, parents, locals, worlds, updated })).code).toBe("VGPU-SPATIAL-ORDER");
    expect(Array.from(worlds)).toEqual(new Array(32).fill(6));
    expect(Array.from(updated)).toEqual([8, 8]);
    const rebuilt = hierarchyOrder(parents);
    expect(evaluateHierarchy({ order: rebuilt, parents, locals, worlds, updated })).toBe(2);
  });

  test("topology and size errors identify invalid parents, cycles, tokens, and exact lengths", () => {
    expect(caught(() => hierarchyOrder(new Int32Array([-2]))).code).toBe("VGPU-SPATIAL-PARENT");
    expect(caught(() => hierarchyOrder(new Int32Array([1, 0]))).code).toBe("VGPU-SPATIAL-CYCLE");
    expect(caught(() => hierarchyOrder(new Int32Array([0]))).code).toBe("VGPU-SPATIAL-CYCLE");

    const parents = new Int32Array([-1]);
    const order = hierarchyOrder(parents);
    const valid = { order, parents, locals: matrices({}), worlds: new Float32Array(16) };
    expect(caught(() => evaluateHierarchy({ ...valid, order: { size: 1 } })).code).toBe("VGPU-SPATIAL-ORDER");
    expect(caught(() => evaluateHierarchy({ ...valid, locals: new Float32Array(15) })).code).toBe("VGPU-SPATIAL-SIZE");
    expect(caught(() => evaluateHierarchy({ ...valid, worlds: new Float32Array(17) })).code).toBe("VGPU-SPATIAL-SIZE");
    expect(caught(() => evaluateHierarchy({ ...valid, changed: new Uint8Array(2) })).code).toBe("VGPU-SPATIAL-SIZE");
    expect(caught(() => evaluateHierarchy({ ...valid, updated: new Uint8Array(0) })).code).toBe("VGPU-SPATIAL-SIZE");
  });

  test("writable outputs reject byte-range overlap with every input and each other", () => {
    const order = hierarchyOrder(new Int32Array([-1]));
    const separateParents = new Int32Array([-1]);
    const separateLocals = matrices({});
    const separateWorlds = new Float32Array(16);
    const separateChanged = new Uint8Array([1]);
    const separateUpdated = new Uint8Array(1);
    type Parts = { parents: Int32Array; locals: Float32Array; worlds: Float32Array; changed: Uint8Array; updated: Uint8Array };
    const base = (): Parts => ({
      parents: new Int32Array(separateParents),
      locals: new Float32Array(separateLocals),
      worlds: new Float32Array(separateWorlds),
      changed: new Uint8Array(separateChanged),
      updated: new Uint8Array(separateUpdated),
    });
    const cases: Array<() => Parts> = [
      () => { const p = base(); const b = new ArrayBuffer(64); p.worlds = new Float32Array(b); p.parents = new Int32Array(b, 0, 1); p.parents[0] = -1; return p; },
      () => { const p = base(); const b = new ArrayBuffer(64); p.worlds = new Float32Array(b); p.locals = new Float32Array(b); return p; },
      () => { const p = base(); const b = new ArrayBuffer(64); p.worlds = new Float32Array(b); p.changed = new Uint8Array(b, 1, 1); return p; },
      () => { const p = base(); const b = new ArrayBuffer(64); p.worlds = new Float32Array(b); p.updated = new Uint8Array(b, 2, 1); return p; },
      () => { const p = base(); const b = new ArrayBuffer(4); p.parents = new Int32Array(b); p.parents[0] = -1; p.updated = new Uint8Array(b, 1, 1); return p; },
      () => { const p = base(); const b = new ArrayBuffer(64); p.locals = new Float32Array(b); p.updated = new Uint8Array(b, 3, 1); return p; },
      () => { const p = base(); const b = new ArrayBuffer(2); p.changed = new Uint8Array(b, 0, 1); p.updated = new Uint8Array(b, 0, 1); return p; },
    ];
    for (const make of cases) {
      const parts = make();
      const worldsBefore = Array.from(parts.worlds);
      const updatedBefore = Array.from(parts.updated);
      expect(caught(() => evaluateHierarchy({ order, ...parts })).code).toBe("VGPU-SPATIAL-ALIAS");
      expect(Array.from(parts.worlds)).toEqual(worldsBefore);
      expect(Array.from(parts.updated)).toEqual(updatedBefore);
    }
  });

  test("disjoint views of one buffer are accepted and read-only inputs may overlap", () => {
    const order = hierarchyOrder(new Int32Array([-1]));
    const buffer = new ArrayBuffer(140);
    const parents = new Int32Array(buffer, 0, 1);
    parents[0] = -1;
    const locals = new Float32Array(buffer, 4, 16);
    composeMatrix({ position: [2, 3, 4] }, locals);
    const worlds = new Float32Array(buffer, 68, 16);
    const changed = new Uint8Array(buffer, 132, 1);
    const updated = new Uint8Array(buffer, 133, 1);
    changed[0] = 1;
    expect(evaluateHierarchy({ order, parents, locals, worlds, changed, updated })).toBe(1);
    expectClose(worlds, locals);

    const readOnlyBuffer = new ArrayBuffer(64);
    const overlappingParents = new Int32Array(readOnlyBuffer, 0, 1);
    overlappingParents[0] = -1;
    const overlappingLocals = new Float32Array(readOnlyBuffer, 0, 16);
    expect(evaluateHierarchy({
      order,
      parents: overlappingParents,
      locals: overlappingLocals,
      changed: new Uint8Array(readOnlyBuffer, 0, 1),
      worlds: new Float32Array(16),
    })).toBe(1);
  });

  test("flat evaluation matches node worlds for rotations and nonuniform scales", () => {
    const root = group({ position: [1, 2, 3], rotation: [0.2, -0.3, 0.4], scale: [2, 3, 4] });
    const child = group({ position: [-2, 1, 5], rotation: [-0.1, 0.5, 0.2], scale: [-1, 0.5, 2] });
    root.add(child);
    const parents = new Int32Array([-1, 0]);
    const locals = new Float32Array(32);
    locals.set(root.localMatrix, 0);
    locals.set(child.localMatrix, 16);
    const worlds = new Float32Array(32);

    evaluateHierarchy({ order: hierarchyOrder(parents), parents, locals, worlds });
    expectClose(worlds.subarray(0, 16), root.worldMatrix);
    expectClose(worlds.subarray(16, 32), child.worldMatrix);
  });
});
