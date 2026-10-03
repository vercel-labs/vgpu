import { expect, test } from "vitest";
import { prepareShader } from "@vgpu/wgsl/prepare";
import { decodePackedMetadata } from "../src/packed-metadata.ts";
import { encodePackedMetadata, packedDataKey } from "../src/packed/encode.ts";
import { PACKED_LIMITS } from "../src/packed/format.ts";

const PACKED_ERROR_FIX = "Rebuild with compatible @vgpu/wgsl loader assets.";

test("encodes the golden tuple and roundtrips ordinary data", () => {
  const value = { a: 1, b: ["x", null] };
  const encoded = encodePackedMetadata(value);

  expect(encoded).toEqual([
    1,
    [["a", "b"]],
    [
      [-1, "x", null],
      [0, 1, [0]],
    ],
    [1],
  ]);
  expect(decodePackedMetadata(encoded)).toEqual(value);
  expect(packedDataKey(value)).toBe('{"a":1,"b":["x",null]}');
});

test("interns only exact nodes while preserving key names and order", () => {
  const value = {
    left: { name: "same", count: 1 },
    right: { name: "same", count: 1 },
    renamed: { label: "same", count: 1 },
    reordered: { count: 1, name: "same" },
  };
  const first = encodePackedMetadata(value);

  expect(first).toEqual([
    1,
    [
      ["left", "right", "renamed", "reordered"],
      ["name", "count"],
      ["label", "count"],
      ["count", "name"],
    ],
    [
      [1, "same", 1],
      [2, "same", 1],
      [3, 1, "same"],
      [0, [0], [0], [1], [2]],
    ],
    [3],
  ]);
  expect(encodePackedMetadata(structuredClone(value))).toEqual(first);
  expect(packedDataKey(value.reordered)).not.toBe(packedDataKey(value.left));
});

test("expands every local and shared occurrence into fresh mutable data", () => {
  const sharedValue = { name: "shared", nested: [1, 2] };
  const sharedTable = encodePackedMetadata(sharedValue)!;
  const mainTable = encodePackedMetadata(
    [structuredClone(sharedValue), structuredClone(sharedValue)],
    [sharedValue],
  )!;

  expect(mainTable).toEqual([1, [], [[-1, [-1, 0], [-1, 0]]], [0]]);
  expect(encodePackedMetadata(sharedValue, [sharedValue])).toEqual([1, [], [], [-1, 0]]);
  expect(encodePackedMetadata(sharedValue, [structuredClone(sharedValue), sharedValue])).toEqual([1, [], [], [-1, 0]]);

  deepFreeze(mainTable);
  deepFreeze(sharedTable);
  const encodedSnapshot = JSON.stringify([mainTable, sharedTable]);
  const first = decodePackedMetadata(mainTable, [sharedTable]) as Array<{ name: string; nested: number[] }>;
  const second = decodePackedMetadata(mainTable, [sharedTable]) as Array<{ name: string; nested: number[] }>;

  expect(first[0]).not.toBe(first[1]);
  expect(first[0]!.nested).not.toBe(first[1]!.nested);
  expect(first[0]).not.toBe(second[0]);
  first[0]!.name = "mutated";
  first[0]!.nested[0] = 99;
  expect(first[1]).toEqual(sharedValue);
  expect(second[0]).toEqual(sharedValue);
  expect(JSON.stringify([mainTable, sharedTable])).toBe(encodedSnapshot);

  const mutableShared = structuredClone(sharedTable) as unknown[];
  const retained = decodePackedMetadata(mainTable, [mutableShared]) as Array<{ name: string; nested: number[] }>;
  mutableShared[3] = null;
  expect(retained[0]).toEqual(sharedValue);
});

test("roundtrips hostile keys and exact UTF-16 string data without prototype mutation", () => {
  const text = "café 😀 \u2028\u2029 \ud800 \udc00 \\\"\n";
  const value = JSON.parse(
    '{"0":"numeric","__proto__":{"polluted":true},"constructor":"ctor","prototype":"proto","toString":"own","":"empty","01":null}',
  ) as Record<string, unknown>;
  Object.defineProperty(value, "01", {
    value: text,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const encoded = encodePackedMetadata(value)!;
  const decoded = decodePackedMetadata(encoded) as Record<string, unknown>;

  expect(packedDataKey(value)).toBe(JSON.stringify(value));
  expect(JSON.stringify(decoded)).toBe(JSON.stringify(value));
  expect(Object.keys(decoded)).toEqual(Object.keys(value));
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
  expect(decoded.__proto__).toEqual({ polluted: true });
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")).toMatchObject({
    enumerable: true,
    writable: true,
    configurable: true,
  });
  expect(structuredClone(decoded)).toStrictEqual(value);
});

test("roundtrips complete prepared reflection without exposing packing publicly", () => {
  const wgsl = `
    enable f16;
    alias Half = f16;
    struct Nested {
      tint: vec4<Half>,
      samples: array<vec2f, 3>,
    }
    struct Params {
      @align(16) @size(64) transform: mat3x2<f32>,
      nested: Nested,
    }
    struct RuntimeData { values: array<vec4f> }
    @group(0) @binding(0) var<uniform> params: Params;
    @group(0) @binding(1) var<storage, read_write> data: RuntimeData;
    @group(1) @binding(0) var image: texture_2d<f32>;
    @group(1) @binding(1) var imageSampler: sampler;
    @id(7) override WIDTH: u32;
    @compute @workgroup_size(WIDTH, 2, 1) fn computeMain() {
      data.values[0] = vec4f(params.transform[0], 0.0, 1.0);
    }
    @vertex fn vertexMain(@location(0) position: vec2f) -> @builtin(position) vec4f {
      return vec4f(position, 0.0, 1.0);
    }
    @fragment fn fragmentMain() -> @location(0) vec4f {
      return textureSample(image, imageSampler, vec2f(0.5));
    }
  `;
  const absent = prepareShader(wgsl);
  const empty = prepareShader({ wgsl, functionExports: [] });

  for (const prepared of [absent, empty]) {
    const reflectionTable = encodePackedMetadata(prepared.reflection);
    const fullTable = encodePackedMetadata(prepared);
    expect(reflectionTable).not.toBeNull();
    expect(fullTable).not.toBeNull();
    expect(decodePackedMetadata(reflectionTable)).toStrictEqual(prepared.reflection);
    const decoded = decodePackedMetadata(fullTable);
    expect(decoded).toStrictEqual(prepared);
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(prepared));
    expect(structuredClone(decoded)).toStrictEqual(prepared);
    expectOwnData(decoded, prepared);
  }

  expect(absent).not.toHaveProperty("functionExports");
  expect(empty).toHaveProperty("functionExports", []);
  expect(Object.keys(absent)).toEqual(["version", "wgsl", "reflection", "sourceChecksum", "producer"]);
  expect(absent.reflection.entryPoints[0]?.workgroupSize).toEqual(["unresolved", 2, 1]);
});

test("keeps a large generated ordinary reflection below codec limits", () => {
  const members = Array.from(
    { length: 512 },
    (_, index) => `field${index}: array<vec4f, 4>,`,
  ).join("\n");
  const prepared = prepareShader(`
    struct LargeRecord {
      ${members}
    }
    @group(0) @binding(0) var<storage, read_write> records: array<LargeRecord>;
    @compute @workgroup_size(8, 4, 1) fn main() {
      records[0].field511[3] = vec4f(1.0);
    }
  `);

  const table = encodePackedMetadata(prepared.reflection);
  expect(table).not.toBeNull();
  expect(decodePackedMetadata(table)).toStrictEqual(prepared.reflection);
});

test("rejects unsupported producer data without invoking accessors or toJSON", () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  const withToJSON = Object.defineProperty({ ok: true }, "toJSON", {
    enumerable: false,
    get() {
      calls++;
      return () => "wrong";
    },
  });

  const sparse = Array(1);
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  accessorArray.length = 1;
  const extraArray = [1];
  Object.defineProperty(extraArray, "named", { value: true, enumerable: true });
  const symbolRecord = { ok: true };
  Object.defineProperty(symbolRecord, Symbol("extra"), { value: true });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;

  const invalidValues = [
    accessor,
    withToJSON,
    sparse,
    accessorArray,
    extraArray,
    symbolRecord,
    cycle,
    undefined,
    () => undefined,
    Symbol("value"),
    1n,
    -0,
    NaN,
    Infinity,
    new Date(0),
  ];
  invalidValues.forEach((value, index) => {
    expect(encodePackedMetadata(value), `case ${index}`).toBeNull();
    expect(packedDataKey(value), `case ${index}`).toBeNull();
  });
  expect(calls).toBe(0);
});

test("accepts null-prototype own-data records and decodes ordinary objects", () => {
  const value = Object.create(null) as Record<string, unknown>;
  value.answer = 42;

  expect(packedDataKey(value)).toBe('{"answer":42}');
  const decoded = decodePackedMetadata(encodePackedMetadata(value)) as Record<string, unknown>;
  expect(decoded).toEqual({ answer: 42 });
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
});

test("reports deterministic decoder error categories", () => {
  expectInvalid([2, [], [], null], "version");

  const sparse = Array(4);
  sparse[0] = 1;
  expectInvalid(sparse, "table");
});

test("rejects malformed tables completely, including unreachable data", () => {
  const duplicateShapeKey = [1, [["x", "x"]], [], null];
  const wrongArity = [1, [["x"]], [[0]], [0]];
  const forwardReference = [1, [], [[-1, [1]], [-1]], [0]];
  const selfReference = [1, [], [[-1, [0]]], [0]];
  const danglingRoot = [1, [], [], [0]];
  const externalWithoutBlock = [1, [], [], [-1, 0]];
  const invalidUnreachableNode = [1, [], [[-2]], null];
  const invalidUnreachableValue = [1, [], [[-1, -0]], null];
  const invalidRoot = [1, [], [], {}];

  for (const [value, reason] of [
    [[1, [], []], "table"],
    [[1, [], [], null, null], "table"],
    [duplicateShapeKey, "shape"],
    [wrongArity, "node"],
    [forwardReference, "reference"],
    [selfReference, "reference"],
    [danglingRoot, "reference"],
    [externalWithoutBlock, "reference"],
    [invalidUnreachableNode, "node"],
    [invalidUnreachableValue, "value"],
    [[1, [], [[-1, Number.NaN]], null], "value"],
    [[1, [], [[-1, Number.POSITIVE_INFINITY]], null], "value"],
    [[1, [], [[-1, [1.5]]], null], "reference"],
    [[1, [], [[-1, [Number.MAX_SAFE_INTEGER + 1]]], null], "reference"],
    [[1, [], [[-1, [0, 0]]], null], "reference"],
    [[1, [[0]], [], null], "shape"],
    [[1, [["b", "0"]], [[0, "B", "Z"]], [0]], "shape"],
    [[1, [[]], [[1]], [0]], "node"],
    [[1, [], [[-1, {}]], [0]], "value"],
    [[1, [], [[-1]], [-0]], "reference"],
    [[1, [["a"]], [[-0, 1]], [0]], "node"],
    [invalidRoot, "value"],
  ] as const) {
    const snapshot = JSON.stringify(value);
    expectInvalid(value, reason);
    expect(JSON.stringify(value)).toBe(snapshot);
  }

  const sharedWithExternal = [1, [], [], [-1, 0]];
  expectInvalid([1, [], [], null], "reference", [sharedWithExternal]);
  expectInvalid([1, [], [], [-1, -0]], "reference", [[1, [], [], "shared"]]);
  expectInvalid([1, [], [], [-1, 1]], "reference", [[1, [], [], "shared"]]);
  expectInvalid([1, [], [], null], "reference", [[1, [], [[-1, [-1, 0]]], [0]]]);

  let getterCalls = 0;
  const accessorTable = [1, [], [], null];
  Object.defineProperty(accessorTable, "3", {
    enumerable: true,
    get() {
      getterCalls++;
      return null;
    },
  });
  expectInvalid(accessorTable, "table");
  expect(getterCalls).toBe(0);

  const symbolTable = [1, [], [], null];
  Object.defineProperty(symbolTable, Symbol("extra"), { value: true });
  expectInvalid(symbolTable, "table");

  const namedTable = [1, [], [], null];
  Object.defineProperty(namedTable, "extra", { value: true });
  expectInvalid(namedTable, "table");

  const wrongPrototype = [1, [], [], null];
  Object.setPrototypeOf(wrongPrototype, null);
  expectInvalid(wrongPrototype, "table");
});

test("rejects fixed-length wire arrays before traversing their elements", () => {
  let envelopeElementsRead = 0;
  const envelope = new Proxy(Array(5).fill(null), {
    getOwnPropertyDescriptor(target, key) {
      if (key !== "length") envelopeElementsRead++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  expectInvalid(envelope, "table");
  expect(envelopeElementsRead).toBe(0);

  let referenceElementsRead = 0;
  const reference = new Proxy([0, 0, 0], {
    getOwnPropertyDescriptor(target, key) {
      if (key !== "length") referenceElementsRead++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  expectInvalid([1, [], [[-1, reference]], null], "reference");
  expect(referenceElementsRead).toBe(0);
});

test("enforces table, shape, node, depth, and input-length bounds inclusively", () => {
  const scalarTable = [1, [], [], null];
  expect(decodePackedMetadata(scalarTable, Array(16).fill(scalarTable))).toBeNull();
  expect(encodePackedMetadata(null, Array(16).fill(null))).not.toBeNull();
  expectInvalid(scalarTable, "limit", Array(17).fill(scalarTable));
  expect(encodePackedMetadata(null, Array(17).fill(null))).toBeNull();

  const shapes = Array.from({ length: PACKED_LIMITS.shapes }, (_, index) => [`k${index}`]);
  expect(decodePackedMetadata([1, shapes, [], null])).toBeNull();
  expectInvalid([1, [...shapes, ["over"]], [], null], "limit");

  const nodes = Array.from({ length: PACKED_LIMITS.nodes }, () => [-1]);
  expect(decodePackedMetadata([1, [], nodes, null])).toBeNull();
  expectInvalid([1, [], [...nodes, [-1]], null], "limit");

  const depthNodes = Array.from({ length: PACKED_LIMITS.depth }, (_, index) => (
    index === 0 ? [-1] : [-1, [index - 1]]
  ));
  expect(nestingDepth(decodePackedMetadata([1, [], depthNodes, [depthNodes.length - 1]]))).toBe(PACKED_LIMITS.depth);
  expectInvalid([1, [], [...depthNodes, [-1, [depthNodes.length - 1]]], [depthNodes.length]], "limit");

  const hugeSparse = Array(PACKED_LIMITS.encodedSlots + 1);
  expectInvalid(hugeSparse, "table");
});

test("enforces encoded-slot, expansion, and string-unit bounds before allocation", () => {
  const slotRow = Array(PACKED_LIMITS.encodedSlots - 10).fill(null);
  slotRow[0] = -1;
  const slotTable = [1, [], [slotRow], null];
  const scalarTable = [1, [], [], null];
  expect(decodePackedMetadata(scalarTable, [slotTable])).toBeNull();
  slotRow.push(null);
  expectInvalid(scalarTable, "limit", [slotTable]);

  const expansionNodes: unknown[][] = [[-1]];
  for (let index = 1; index < 19; index++) {
    expansionNodes.push([-1, [index - 1], [index - 1]]);
  }
  const expansionRoot = [
    -1,
    ...expansionNodes.map((_, index) => [index]),
    ...Array(20).fill(null),
  ];
  expansionNodes.push(expansionRoot);
  const expansionTable = [1, [], expansionNodes, null];
  expect(decodePackedMetadata(expansionTable)).toBeNull();
  expansionRoot.push(null);
  expectInvalid(expansionTable, "limit");

  const sharedNodes: unknown[][] = [[-1]];
  for (let index = 1; index < 19; index++) sharedNodes.push([-1, [index - 1], [index - 1]]);
  const sharedTable = [1, [], sharedNodes, [sharedNodes.length - 1]];
  expect(decodePackedMetadata([1, [], [[-1, [-1, 0], [-1, 0]]], null], [sharedTable])).toBeNull();
  expectInvalid([1, [], [[-1, [-1, 0], [-1, 0], [-1, 0]]], null], "limit", [sharedTable]);

  const stringNodes: unknown[][] = [[-1, "x".repeat(1024)]];
  for (let index = 1; index <= 13; index++) stringNodes.push([-1, [index - 1], [index - 1]]);
  const stringExpansionTable = [1, [], stringNodes, null];
  expect(decodePackedMetadata(stringExpansionTable)).toBeNull();
  stringNodes.push([-1, [13], [13]]);
  expectInvalid(stringExpansionTable, "limit");

  const maximumString = "x".repeat(PACKED_LIMITS.expandedStringUnits);
  expect(decodePackedMetadata([1, [], [], maximumString])).toBe(maximumString);
  const excessiveString = `${maximumString}x`;
  expectInvalid([1, [[excessiveString]], [], null], "limit");
  expect(encodePackedMetadata(excessiveString)).toBeNull();

  let maximumDepth: unknown = null;
  for (let index = 0; index < PACKED_LIMITS.depth; index++) maximumDepth = [maximumDepth];
  expect(encodePackedMetadata(maximumDepth)).not.toBeNull();
  expect(encodePackedMetadata([maximumDepth])).toBeNull();
});

test("producer falls back at shape, node, slot, and combined shared limits", () => {
  const tooManyShapes = Array.from(
    { length: PACKED_LIMITS.shapes + 1 },
    (_, index) => ({ [`field${index}`]: null }),
  );
  expect(encodePackedMetadata(tooManyShapes)).toBeNull();

  const tooManyNodes = Array.from(
    { length: PACKED_LIMITS.nodes },
    (_, index) => [index],
  );
  expect(encodePackedMetadata(tooManyNodes)).toBeNull();

  const sharedValue = Array(PACKED_LIMITS.encodedSlots - 12).fill(null);
  expect(encodePackedMetadata(null, [sharedValue])).not.toBeNull();
  sharedValue.push(null);
  expect(encodePackedMetadata(null, [sharedValue])).toBeNull();
});

function expectInvalid(value: unknown, reason: string, sharedTables?: readonly unknown[]): void {
  try {
    decodePackedMetadata(value, sharedTables);
    throw new Error("expected packed metadata rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(error).toMatchObject({
      code: "VGPU-WGSL-PACKED-METADATA-INVALID",
      fix: PACKED_ERROR_FIX,
      message: `Invalid packed WGSL metadata: ${reason}. ${PACKED_ERROR_FIX}`,
    });
  }
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) deepFreeze(nested);
  Object.freeze(value);
}

function nestingDepth(value: unknown): number {
  let depth = 0;
  while (Array.isArray(value)) {
    depth++;
    value = value[0];
  }
  return depth;
}

function expectOwnData(actual: unknown, expected: unknown): void {
  if (typeof expected !== "object" || expected === null) return;
  expect(typeof actual).toBe("object");
  expect(actual).not.toBeNull();
  expect(Array.isArray(actual)).toBe(Array.isArray(expected));
  expect(Object.getPrototypeOf(actual)).toBe(Array.isArray(expected) ? Array.prototype : Object.prototype);
  expect(Object.keys(actual as object)).toEqual(Object.keys(expected));
  for (const key of Object.keys(expected)) {
    expect(Object.getOwnPropertyDescriptor(actual, key)).toMatchObject({
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expectOwnData(
      (actual as Record<string, unknown>)[key],
      (expected as Record<string, unknown>)[key],
    );
  }
}
