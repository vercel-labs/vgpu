import { describe, expect, test } from "vitest";
import {
  getInstanceProtocol,
  withInstanceIdCounterForTesting,
  withInstanceProtocolRevisionForTesting,
} from "../../src/scene/instance-protocol.ts";
import { instances } from "../../src/scene/instances.ts";

function caught(run: () => unknown): { code?: string; fix?: string; cause?: unknown } {
  try {
    run();
    return {};
  } catch (error) {
    return error as { code?: string; fix?: string; cause?: unknown };
  }
}

function floats(bytes: Uint8Array, offset: number, length: number): number[] {
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset + offset, length));
}

function world(tx = 0, ty = 0, tz = 0): Float32Array {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    tx, ty, tz, 1,
  ]);
}

describe("instance collections", () => {
  test("requires a fixed nonnegative integer capacity and reports overflow", () => {
    for (const capacity of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      expect(caught(() => instances({ capacity })).code).toBe("VGPU-INSTANCE-CAPACITY");
    }
    const zero = instances({ capacity: 0 });
    expect(zero.capacity).toBe(0);
    expect(caught(() => zero.add()).code).toBe("VGPU-INSTANCE-CAPACITY");

    const one = instances({ capacity: 1 });
    one.add();
    expect(caught(() => one.add()).code).toBe("VGPU-INSTANCE-CAPACITY");
  });

  test("snapshots declaration-ordered schema and creates identity-world packed records", () => {
    const defaultColor = [0.25, 0.5, 0.75];
    const collection = instances({
      capacity: 2,
      attributes: {
        temperature: "float32",
        color: { format: "float32x3", default: defaultColor },
      },
    });
    defaultColor[0] = 99;

    const id = collection.add({ temperature: 3 });
    const protocol = getInstanceProtocol(collection);

    expect(collection.capacity).toBe(2);
    expect(collection.count).toBe(1);
    expect(collection.slotOf(id)).toBe(0);
    expect(collection.idAt(0)).toBe(id);
    expect(protocol.layout).toEqual({
      capacity: 2,
      stride: 80,
      attributes: [
        { name: "temperature", format: "float32", offset: 64 },
        { name: "color", format: "float32x3", offset: 68 },
      ],
    });
    expect(floats(protocol.records, 0, 16)).toEqual([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    expect(floats(protocol.records, 64, 4)).toEqual([3, 0.25, 0.5, 0.75]);
  });

  test("packs all formats and enforces scalar, vector, float32, and integer ranges", () => {
    const collection = instances({
      capacity: 1,
      attributes: {
        f1: "float32", f2: "float32x2", f3: "float32x3", f4: "float32x4",
        s1: "sint32", s2: "sint32x2", s3: "sint32x3", s4: "sint32x4",
        u1: "uint32", u2: "uint32x2", u3: "uint32x3", u4: "uint32x4",
      },
    });
    collection.add({
      f1: 1.25, f2: [2, 3], f3: [4, 5, 6], f4: [7, 8, 9, 10],
      s1: -0x80000000, s2: [0x7fffffff, -2], s3: [-3, 4, 5], s4: [6, 7, 8, 9],
      u1: 0xffffffff, u2: [0, 2], u3: [3, 4, 5], u4: [6, 7, 8, 9],
    });
    const protocol = getInstanceProtocol(collection);
    expect(protocol.layout.stride).toBe(184);
    const view = new DataView(protocol.records.buffer, protocol.records.byteOffset, protocol.records.byteLength);
    expect(view.getFloat32(64, true)).toBe(1.25);
    expect(view.getInt32(104, true)).toBe(-0x80000000);
    expect(view.getInt32(108, true)).toBe(0x7fffffff);
    expect(view.getUint32(144, true)).toBe(0xffffffff);

    const invalidCases: Array<() => unknown> = [
      () => instances({ capacity: 1, attributes: { value: { format: "float32", default: [1] } } }),
      () => instances({ capacity: 1, attributes: { value: { format: "float32x2", default: 1 } } }),
      () => instances({ capacity: 1, attributes: { value: { format: "float32x2", default: [1] } } }),
      () => instances({ capacity: 1, attributes: { value: { format: "float32", default: Number.MAX_VALUE } } }),
      () => instances({ capacity: 1, attributes: { value: { format: "float32", default: Number.NaN } } }),
      () => instances({ capacity: 1, attributes: { value: { format: "float32", default: Number.POSITIVE_INFINITY } } }),
      () => instances({ capacity: 1, attributes: { value: { format: "sint32", default: 0x80000000 } } }),
      () => instances({ capacity: 1, attributes: { value: { format: "uint32", default: -1 } } }),
      () => instances({ capacity: 1, attributes: { value: { format: "uint32", default: 1.5 } } }),
    ];
    for (const invalid of invalidCases) expect(caught(invalid).code).toBe("VGPU-INSTANCE-VALUE");
  });

  test("packs omitted defaults and explicit overrides for every scalar format", () => {
    const collection = instances({
      capacity: 2,
      attributes: {
        heat: { format: "float32", default: 0.25 },
        signedCode: { format: "sint32", default: -7 },
        kind: { format: "uint32", default: 9 },
      },
    });
    const defaulted = collection.add();
    const overridden = collection.add({ heat: 1.5, signedCode: -2, kind: 0xffffffff });
    const protocol = getInstanceProtocol(collection);
    const view = new DataView(protocol.records.buffer, protocol.records.byteOffset, protocol.records.byteLength);

    const defaultedOffset = collection.slotOf(defaulted) * protocol.layout.stride;
    expect(view.getFloat32(defaultedOffset + 64, true)).toBe(0.25);
    expect(view.getInt32(defaultedOffset + 68, true)).toBe(-7);
    expect(view.getUint32(defaultedOffset + 72, true)).toBe(9);

    const overriddenOffset = collection.slotOf(overridden) * protocol.layout.stride;
    expect(view.getFloat32(overriddenOffset + 64, true)).toBe(1.5);
    expect(view.getInt32(overriddenOffset + 68, true)).toBe(-2);
    expect(view.getUint32(overriddenOffset + 72, true)).toBe(0xffffffff);
  });

  test("preserves scalar and vector default snapshots and packing in mixed schemas", () => {
    const tintDefault = [0.1, 0.2, 0.3];
    const tileDefault = new Uint32Array([4, 5]);
    const collection = instances({
      capacity: 2,
      attributes: {
        heat: { format: "float32", default: 0.5 },
        tint: { format: "float32x3", default: tintDefault },
        layer: { format: "sint32", default: -3 },
        tile: { format: "uint32x2", default: tileDefault },
      },
    });
    tintDefault[0] = 99;
    tileDefault[0] = 99;

    const defaulted = collection.add();
    const overridden = collection.add({
      heat: 1.25,
      tint: [0.4, 0.5, 0.6],
      layer: 7,
      tile: [8, 9],
    });
    const protocol = getInstanceProtocol(collection);
    const view = new DataView(protocol.records.buffer, protocol.records.byteOffset, protocol.records.byteLength);

    const defaultedOffset = collection.slotOf(defaulted) * protocol.layout.stride;
    expect(floats(protocol.records, defaultedOffset + 64, 4)).toEqual([
      0.5,
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
    expect(view.getInt32(defaultedOffset + 80, true)).toBe(-3);
    expect(view.getUint32(defaultedOffset + 84, true)).toBe(4);
    expect(view.getUint32(defaultedOffset + 88, true)).toBe(5);

    const overriddenOffset = collection.slotOf(overridden) * protocol.layout.stride;
    expect(floats(protocol.records, overriddenOffset + 64, 4)).toEqual([
      1.25,
      Math.fround(0.4),
      0.5,
      Math.fround(0.6),
    ]);
    expect(view.getInt32(overriddenOffset + 80, true)).toBe(7);
    expect(view.getUint32(overriddenOffset + 84, true)).toBe(8);
    expect(view.getUint32(overriddenOffset + 88, true)).toBe(9);
  });

  test("rejects invalid schema names/formats and atomically validates add and set fields", () => {
    for (const name of ["", " ", "0", "12", "1.5", "-2", "+3", "1e2", "0xff", "Infinity", "world0", "world1", "world2", "world3"]) {
      expect(caught(() => instances({ capacity: 1, attributes: { [name]: "float32" } })).code)
        .toBe("VGPU-INSTANCE-ATTRIBUTE");
    }
    expect(caught(() => instances({ capacity: 1, attributes: { bad: "float16" as "float32" } })).code)
      .toBe("VGPU-INSTANCE-ATTRIBUTE");
    expect(caught(() => instances({ capacity: 1, attributes: null as never })).code)
      .toBe("VGPU-INSTANCE-ATTRIBUTE");

    const collection = instances({ capacity: 2, attributes: { required: "float32", pair: "uint32x2" } });
    const protocol = getInstanceProtocol(collection);
    expect(caught(() => collection.add({ pair: [1, 2] } as never)).code).toBe("VGPU-INSTANCE-ATTRIBUTE");
    expect(caught(() => collection.add({ required: 1, pair: [1, 2], extra: 3 } as never)).code)
      .toBe("VGPU-INSTANCE-ATTRIBUTE");
    expect(caught(() => collection.add({ required: 1, pair: [1, -1] })).code).toBe("VGPU-INSTANCE-VALUE");
    expect(collection.count).toBe(0);
    expect(protocol.revision).toBe(0);

    const id = collection.add({ required: 1, pair: [2, 3] });
    const before = Array.from(protocol.records);
    const revision = protocol.revision;
    expect(caught(() => collection.set(id, { required: 9, pair: [4, -1] })).code).toBe("VGPU-INSTANCE-VALUE");
    expect(Array.from(protocol.records)).toEqual(before);
    expect(protocol.revision).toBe(revision);
    expect(caught(() => collection.set(id, { extra: 1 } as never)).code).toBe("VGPU-INSTANCE-ATTRIBUTE");

    collection.set(id, { required: 9, pair: new Uint32Array([4, 5]) });
    const view = new DataView(protocol.records.buffer, protocol.records.byteOffset, protocol.records.byteLength);
    expect(view.getFloat32(64, true)).toBe(9);
    expect(view.getUint32(68, true)).toBe(4);
    expect(view.getUint32(72, true)).toBe(5);
    expect(protocol.slotRevision(0)).toBe(protocol.revision);

    const patchCollection = instances({
      capacity: 2,
      attributes: {
        required: "float32",
        color: { format: "float32x3", default: [1, 1, 1] },
      },
    });
    const patchId = patchCollection.add({ required: 1, color: [0.1, 0.2, 0.3] });
    patchCollection.set(patchId, { required: 5 });
    const patchProtocol = getInstanceProtocol(patchCollection);
    expect(floats(patchProtocol.records, 64, 4)).toEqual([
      5,
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
    const defaultedId = patchCollection.add({ required: 2, color: undefined });
    expect(floats(patchProtocol.records, patchCollection.slotOf(defaultedId) * patchProtocol.layout.stride + 64, 4))
      .toEqual([2, 1, 1, 1]);
  });

  test("keeps collection-specific live identities stable across swap removal", () => {
    const collection = instances({ capacity: 4, attributes: { value: "float32" } });
    const foreign = instances({ capacity: 1, attributes: { value: "float32" } });
    const first = collection.add({ value: 1 });
    const middle = collection.add({ value: 2 });
    const last = collection.add({ value: 3 });
    const foreignId = foreign.add({ value: 9 });
    const protocol = getInstanceProtocol(collection);

    expect(caught(() => collection.slotOf(foreignId)).code).toBe("VGPU-INSTANCE-HANDLE");
    expect(caught(() => collection.remove(123 as typeof first)).code).toBe("VGPU-INSTANCE-HANDLE");
    collection.remove(middle);

    expect(collection.count).toBe(2);
    expect(collection.idAt(0)).toBe(first);
    expect(collection.idAt(1)).toBe(last);
    expect(collection.slotOf(last)).toBe(1);
    expect(floats(protocol.records, protocol.layout.stride + 64, 1)).toEqual([3]);
    expect(protocol.slotRevision(1)).toBe(protocol.revision);
    expect(protocol.countRevision).toBe(protocol.revision);
    expect(caught(() => collection.slotOf(middle)).code).toBe("VGPU-INSTANCE-HANDLE");
    expect(caught(() => collection.remove(middle)).code).toBe("VGPU-INSTANCE-HANDLE");

    collection.remove(last);
    expect(collection.count).toBe(1);
    const replacement = collection.add({ value: 4 });
    expect(replacement).not.toBe(middle);
    expect(replacement).not.toBe(last);
    expect(caught(() => collection.idAt(-1)).code).toBe("VGPU-INSTANCE-RANGE");
    expect(caught(() => collection.idAt(2)).code).toBe("VGPU-INSTANCE-RANGE");
    expect(caught(() => collection.idAt(0.5)).code).toBe("VGPU-INSTANCE-RANGE");
  });

  test("writes finite affine worlds while allowing shear and reflection", () => {
    const collection = instances({ capacity: 1 });
    const id = collection.add();
    const protocol = getInstanceProtocol(collection);
    const matrix = [
      -2, 0, 0, 0,
      0.5, 3, 0, 0,
      0, 0.25, 4, 0,
      5, 6, 7, 1,
    ];
    collection.setWorld(id, matrix);
    expect(floats(protocol.records, 0, 16)).toEqual(matrix);

    const before = Array.from(protocol.records);
    const revision = protocol.revision;
    const invalid = [
      matrix.slice(0, 15),
      matrix.map((value, index) => index === 4 ? Number.NaN : value),
      matrix.map((value, index) => index === 5 ? Number.MAX_VALUE : value),
      matrix.map((value, index) => index === 3 ? 1e-50 : value),
      matrix.map((value, index) => index === 15 ? 1 + Number.EPSILON : value),
    ];
    for (const candidate of invalid) {
      expect(caught(() => collection.setWorld(id, candidate)).code).toBe("VGPU-INSTANCE-VALUE");
      expect(Array.from(protocol.records)).toEqual(before);
      expect(protocol.revision).toBe(revision);
    }
  });

  test("preflights entire world batches including ranges, identities, duplicates, bindings, and late matrices", () => {
    const collection = instances({ capacity: 4 });
    const first = collection.add();
    const second = collection.add();
    const third = collection.add();
    const removed = collection.add();
    collection.remove(removed);
    const protocol = getInstanceProtocol(collection);
    const source = new Float32Array(4 * 16);
    source.set(world(99), 0);
    source.set(world(1, 2, 3), 16);
    source.set(world(4, 5, 6), 32);
    source.set(world(7, 8, 9), 48);

    collection.setWorlds([third, first], source, 1);
    expect(floats(protocol.records, collection.slotOf(third) * protocol.layout.stride, 16)).toEqual(Array.from(world(1, 2, 3)));
    expect(floats(protocol.records, collection.slotOf(first) * protocol.layout.stride, 16)).toEqual(Array.from(world(4, 5, 6)));
    const before = Array.from(protocol.records);
    const revision = protocol.revision;

    expect(caught(() => collection.setWorlds([], new Float32Array(0), 1)).code).toBeUndefined();
    expect(protocol.revision).toBe(revision);
    expect(caught(() => collection.setWorlds([first], source, -1)).code).toBe("VGPU-INSTANCE-RANGE");
    expect(caught(() => collection.setWorlds([first], source, 0.5)).code).toBe("VGPU-INSTANCE-RANGE");
    expect(caught(() => collection.setWorlds([first, second], source, 3)).code).toBe("VGPU-INSTANCE-RANGE");
    expect(caught(() => collection.setWorlds([first, first], source)).code).toBe("VGPU-INSTANCE-RANGE");
    expect(caught(() => collection.setWorlds([first, removed], source)).code).toBe("VGPU-INSTANCE-HANDLE");
    expect(caught(() => collection.setWorlds([first], [1, 2] as unknown as Float32Array)).code)
      .toBe("VGPU-INSTANCE-VALUE");
    expect(caught(() => collection.setWorlds(null as unknown as [], source)).code).toBe("VGPU-INSTANCE-RANGE");
    expect(Array.from(protocol.records)).toEqual(before);
    expect(protocol.revision).toBe(revision);

    const invalidLate = new Float32Array(source);
    invalidLate[16 + 3] = 1;
    expect(caught(() => collection.setWorlds([first, second], invalidLate)).code).toBe("VGPU-INSTANCE-VALUE");
    expect(Array.from(protocol.records)).toEqual(before);
    expect(protocol.revision).toBe(revision);
  });

  test("binds synchronous copied worlds while keeping attributes writable", () => {
    const collection = instances({ capacity: 3, attributes: { value: "float32" } });
    const first = collection.add({ value: 1 });
    const second = collection.add({ value: 2 });
    let calls = 0;
    const source = world(2, 3, 4);
    collection.bindWorld(first, () => { calls++; return source; });

    expect(caught(() => collection.bindWorld(first, () => world())).code).toBe("VGPU-INSTANCE-BOUND");
    expect(caught(() => collection.setWorld(first, world())).code).toBe("VGPU-INSTANCE-BOUND");
    const beforeSecond = floats(getInstanceProtocol(collection).records, collection.slotOf(second) * 68, 16);
    expect(caught(() => collection.setWorlds([second, first], new Float32Array([...world(8), ...world(9)]))).code)
      .toBe("VGPU-INSTANCE-BOUND");
    expect(floats(getInstanceProtocol(collection).records, collection.slotOf(second) * 68, 16)).toEqual(beforeSecond);

    collection.set(first, { value: 7 });
    expect(collection.syncWorlds()).toBe(1);
    expect(calls).toBe(1);
    source[12] = 99;
    expect(floats(getInstanceProtocol(collection).records, collection.slotOf(first) * 68, 16)).toEqual(Array.from(world(2, 3, 4)));

    collection.unbindWorld(first);
    collection.unbindWorld(first);
    collection.setWorld(first, world(5));
    expect(collection.syncWorlds()).toBe(0);
    expect(caught(() => collection.unbindWorld(999 as typeof first)).code).toBe("VGPU-INSTANCE-HANDLE");

    collection.bindWorld(second, () => world(6));
    collection.remove(second);
    expect(collection.syncWorlds()).toBe(0);
  });

  test("reports source failures with causes, permits explicit recovery, and documents partial copies", () => {
    const collection = instances({ capacity: 3 });
    const first = collection.add();
    const second = collection.add();
    const third = collection.add();
    const failure = new Error("physics unavailable");
    collection.bindWorld(first, () => world(11));
    collection.bindWorld(second, () => { throw failure; });
    collection.bindWorld(third, () => world(33));
    const protocol = getInstanceProtocol(collection);
    const secondBefore = protocol.slotRevision(collection.slotOf(second));
    const thirdBefore = protocol.slotRevision(collection.slotOf(third));

    const error = caught(() => collection.syncWorlds());
    expect(error.code).toBe("VGPU-INSTANCE-SOURCE");
    expect(error.cause).toBe(failure);
    expect(floats(protocol.records, collection.slotOf(first) * 64, 16)).toEqual(Array.from(world(11)));
    expect(protocol.slotRevision(collection.slotOf(second))).toBe(secondBefore);
    expect(protocol.slotRevision(collection.slotOf(third))).toBe(thirdBefore);

    collection.unbindWorld(second);
    collection.bindWorld(second, () => [1, 2]);
    const invalid = caught(() => collection.syncWorlds());
    expect(invalid.code).toBe("VGPU-INSTANCE-SOURCE");
    expect((invalid.cause as { code?: string }).code).toBe("VGPU-INSTANCE-VALUE");
    collection.unbindWorld(second);
    expect(collection.syncWorlds()).toBe(2);
  });

  test("blocks every mutation, recursive sync, and publication guard during source access", () => {
    const operations = [
      (collection: ReturnType<typeof instances>, id: ReturnType<typeof collection.add>) => collection.add(),
      (collection: ReturnType<typeof instances>, id: ReturnType<typeof collection.add>) => collection.remove(id),
      (collection: ReturnType<typeof instances>, id: ReturnType<typeof collection.add>) => collection.set(id, {}),
      (collection: ReturnType<typeof instances>, id: ReturnType<typeof collection.add>) => collection.setWorld(id, world()),
      (collection: ReturnType<typeof instances>, id: ReturnType<typeof collection.add>) => collection.setWorlds([id], world()),
      (collection: ReturnType<typeof instances>, id: ReturnType<typeof collection.add>) => collection.bindWorld(id, () => world()),
      (collection: ReturnType<typeof instances>, id: ReturnType<typeof collection.add>) => collection.unbindWorld(id),
      (collection: ReturnType<typeof instances>) => collection.syncWorlds(),
      (collection: ReturnType<typeof instances>) => getInstanceProtocol(collection).assertNotSyncing(),
    ];
    for (const operation of operations) {
      const collection = instances({ capacity: 2 });
      const bound = collection.add();
      const other = collection.add();
      collection.bindWorld(bound, () => {
        operation(collection, other);
        return world();
      });
      const error = caught(() => collection.syncWorlds());
      expect(error.code).toBe("VGPU-INSTANCE-REENTRANT");
      collection.unbindWorld(bound);
      expect(() => collection.setWorld(bound, world())).not.toThrow();
    }
  });

  test("keeps per-slot and count revisions independently observable by multiple readers", () => {
    const collection = instances({ capacity: 3, attributes: { value: "float32" } });
    const first = collection.add({ value: 1 });
    const second = collection.add({ value: 2 });
    const protocol = getInstanceProtocol(collection);
    let cursorA = 0;
    let cursorB = 0;
    const changedSince = (cursor: number) => Array.from({ length: protocol.count }, (_, slot) => slot)
      .filter((slot) => protocol.slotRevision(slot) > cursor);

    expect(changedSince(cursorA)).toEqual([0, 1]);
    expect(changedSince(cursorB)).toEqual([0, 1]);
    cursorA = protocol.revision;
    collection.set(first, { value: 4 });
    expect(changedSince(cursorA)).toEqual([0]);
    expect(changedSince(cursorB)).toEqual([0, 1]);
    cursorB = protocol.revision;
    collection.bindWorld(first, () => world(12));
    collection.syncWorlds();
    expect(changedSince(cursorA)).toEqual([0]);
    expect(changedSince(cursorB)).toEqual([0]);
    cursorA = protocol.revision;
    cursorB = protocol.revision;
    collection.unbindWorld(first);
    collection.remove(second);
    expect(protocol.count).toBe(1);
    expect(protocol.countRevision).toBeGreaterThan(cursorB);
    expect(Object.isFrozen(protocol.layout)).toBe(true);
    expect(Object.isFrozen(protocol.layout.attributes)).toBe(true);
  });

  test("fails identity and revision exhaustion before mutating collection state", () => {
    const identityCollection = instances({ capacity: 1 });
    withInstanceIdCounterForTesting(identityCollection, Number.MAX_SAFE_INTEGER + 1, () => {
      expect(caught(() => identityCollection.add()).code).toBe("VGPU-INSTANCE-EXHAUSTED");
    });
    expect(identityCollection.count).toBe(0);

    const revisionCollection = instances({ capacity: 1, attributes: { value: "float32" } });
    const id = revisionCollection.add({ value: 1 });
    const protocol = getInstanceProtocol(revisionCollection);
    const before = Array.from(protocol.records);
    withInstanceProtocolRevisionForTesting(revisionCollection, Number.MAX_SAFE_INTEGER, () => {
      expect(caught(() => revisionCollection.set(id, { value: 2 })).code).toBe("VGPU-INSTANCE-EXHAUSTED");
      expect(Array.from(protocol.records)).toEqual(before);
    });
  });
});
