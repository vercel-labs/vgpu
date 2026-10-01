import { expect, test, vi } from "vitest";
import { decodePackedMetadata } from "../src/packed/decode.ts";
import { selectInlinePackedReflection, selectPackedReflection } from "../src/loader-shared/packed-selection.ts";
import * as packedEncoding from "../src/packed/encode.ts";
import { packedDataKey } from "../src/packed/encode.ts";
import { prepareShader } from "../src/prepare.ts";

test("one substantial uniform layout stays on the plain path", () => {
  const reflection = prepareShader(layoutShader([16]), "/single-uniform.wgsl").reflection;
  const key = packedDataKey(reflection.bindings[0]?.layout);

  expect(key).not.toBeNull();
  expect(Buffer.byteLength(key!, "utf8")).toBeGreaterThanOrEqual(2304);
  expect(selectPackedReflection(reflection)).toBeNull();
  expect(selectInlinePackedReflection(reflection)).toBeNull();
});

test("two distinct substantial uniform layouts remain eligible in shared and inline modes", () => {
  const reflection = prepareShader(layoutShader([16, 17]), "/two-uniforms.wgsl").reflection;
  const shared = selectPackedReflection(reflection);
  const inline = selectInlinePackedReflection(reflection);

  expect(shared).not.toBeNull();
  expect(inline).not.toBeNull();
  expect(decodePackedMetadata(shared!.table, shared!.shared.map((item) => item.table))).toEqual(reflection);
  expect(decodePackedMetadata(inline!.table)).toEqual(reflection);
});

test("exact duplicate complete layout keys count once", () => {
  const reflection = structuredClone(prepareShader(layoutShader([16, 17]), "/duplicate-layout.wgsl").reflection);
  reflection.bindings[1]!.layout = structuredClone(reflection.bindings[0]!.layout!);

  expect(packedDataKey(reflection.bindings[1]!.layout)).toBe(packedDataKey(reflection.bindings[0]!.layout));
  expect(selectPackedReflection(reflection)).toBeNull();
  expect(selectInlinePackedReflection(reflection)).toBeNull();
});

test("the same WGSL type under different binding-root names has distinct complete keys", () => {
  const reflection = prepareShader(repeatedTypeShader(16, 2), "/binding-root-identity.wgsl").reflection;
  const keys = reflection.bindings.map((binding) => packedDataKey(binding.layout));

  expect(keys[0]).not.toBe(keys[1]);
  expect(selectPackedReflection(reflection)).not.toBeNull();
  expect(selectInlinePackedReflection(reflection)).not.toBeNull();
});

test("the substantial-layout boundary is inclusive at 2304 UTF-8 bytes", () => {
  const source = prepareShader(layoutShader([16, 17]), "/layout-boundary.wgsl").reflection;
  const below = structuredClone(source);
  const at = structuredClone(source);
  replaceLayout(below, 1, exactLayout(2303));
  replaceLayout(at, 1, exactLayout(2304));

  expect(selectPackedReflection(below)).toBeNull();
  expect(selectInlinePackedReflection(below)).toBeNull();
  expect(selectPackedReflection(at)).not.toBeNull();
  expect(selectInlinePackedReflection(at)).not.toBeNull();
});

test.each([
  ["one uniform plus storage", ["uniform", "storage"]],
  ["two storage layouts", ["storage", "storage"]],
] as const)("%s stays plain", (_label, addressSpaces) => {
  const reflection = prepareShader(addressSpaceShader(addressSpaces), "/address-spaces.wgsl").reflection;

  expect(selectPackedReflection(reflection)).toBeNull();
  expect(selectInlinePackedReflection(reflection)).toBeNull();
});

test("missing, inherited and accessor binding data cannot qualify or execute getters", () => {
  let reads = 0;
  const inherited = Object.create({
    get bindings() {
      reads++;
      return [];
    },
  }) as Parameters<typeof selectPackedReflection>[0];
  const accessor = Object.defineProperty({}, "bindings", {
    enumerable: true,
    get() {
      reads++;
      return [];
    },
  }) as Parameters<typeof selectPackedReflection>[0];

  expect(selectPackedReflection(inherited)).toBeNull();
  expect(selectInlinePackedReflection(inherited)).toBeNull();
  expect(selectPackedReflection(accessor)).toBeNull();
  expect(selectInlinePackedReflection(accessor)).toBeNull();
  expect(reads).toBe(0);
});

test("the guard honors the 256-layout serialization ceiling", () => {
  const within = reflectionWithBindings([
    ...Array.from({ length: 255 }, () => uniformBinding(exactLayout(2304, "first"))),
    uniformBinding(exactLayout(2304, "second")),
  ]);
  const beyond = reflectionWithBindings([
    ...Array.from({ length: 256 }, () => uniformBinding(exactLayout(2304, "first"))),
    uniformBinding(exactLayout(2304, "second")),
  ]);

  expect(selectInlinePackedReflection(within)).not.toBeNull();
  expect(selectInlinePackedReflection(beyond)).toBeNull();
});

test("the guard inspects at most 65,536 binding slots", () => {
  const skipped = { kind: "texture" };
  const first = uniformBinding(exactLayout(2304, "first"));
  const second = uniformBinding(exactLayout(2304, "second"));
  const withinBindings = Array.from({ length: 65_536 }, () => skipped);
  withinBindings[0] = first;
  withinBindings[65_535] = second;
  const beyondBindings = [...withinBindings, second];
  beyondBindings[65_535] = skipped;

  expect(selectInlinePackedReflection(reflectionWithBindings(withinBindings))).not.toBeNull();
  expect(selectInlinePackedReflection(reflectionWithBindings(beyondBindings))).toBeNull();
});

test("the existing 16 KiB raw floor still runs before uniform eligibility", () => {
  const reflection = prepareShader(repeatedTypeShader(6, 2), "/raw-floor.wgsl").reflection;
  const keys = reflection.bindings.map((binding) => packedDataKey(binding.layout));

  expect(keys.every((key) => key !== null && Buffer.byteLength(key, "utf8") >= 2304)).toBe(true);
  expect(Buffer.byteLength(packedDataKey(reflection)!, "utf8")).toBeLessThan(16_384);
  expect(selectPackedReflection(reflection)).toBeNull();
  expect(selectInlinePackedReflection(reflection)).toBeNull();
});

test("the existing raw score still rejects an unprofitable eligible reflection", () => {
  const reflection = {
    bindings: [
      uniformBinding(exactLayout(2304, "first")),
      uniformBinding(exactLayout(2304, "second")),
    ],
    uniquePayload: Array.from({ length: 12_000 }, (_, index) => String.fromCharCode(0x400 + index % 512)).join(""),
  } as unknown as Parameters<typeof selectPackedReflection>[0];

  expect(Buffer.byteLength(packedDataKey(reflection)!, "utf8")).toBeGreaterThanOrEqual(16_384);
  expect(selectPackedReflection(reflection)).toBeNull();
  expect(selectInlinePackedReflection(reflection)).toBeNull();
});

test("query-over-cap candidates retain the existing useful inline fallback", () => {
  const reflection = prepareShader(repeatedTypeShader(20, 4), "/query-cap.wgsl").reflection;
  const plan = selectPackedReflection(reflection);

  expect(plan).not.toBeNull();
  expect(plan!.shared).toEqual([]);
  expect(selectInlinePackedReflection(reflection)).not.toBeNull();
  expect(decodePackedMetadata(plan!.table)).toEqual(reflection);
});

test("selection and canonical query ordering stay deterministic for deep clones", () => {
  const reflection = prepareShader(repeatedTypeShader(8, 4), "/stable-order.wgsl").reflection;
  const first = selectPackedReflection(reflection);
  const cloned = selectPackedReflection(structuredClone(reflection));

  expect(first).not.toBeNull();
  expect(cloned).toEqual(first);
  expect(first!.shared.map((item) => item.query))
    .toEqual(first!.shared.map((item) => item.query).toSorted());
});

test("Unicode, lone surrogates, hostile keys and field order remain complete identity", () => {
  const reflection = structuredClone(prepareShader(layoutShader([16, 17]), "/identity.wgsl").reflection);
  const padding = "x".repeat(2304);
  replaceLayout(reflection, 0, { first: "\ud800é", padding });
  replaceLayout(reflection, 1, { padding, first: "\ud800é" });
  Object.defineProperty(reflection, "__proto__", {
    value: { constructor: "prototype", note: "\udfff" },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const plan = selectInlinePackedReflection(reflection);

  expect(packedDataKey(reflection.bindings[0]!.layout))
    .not.toBe(packedDataKey(reflection.bindings[1]!.layout));
  expect(plan).not.toBeNull();
  expect(decodePackedMetadata(plan!.table)).toEqual(reflection);
  expect(Object.getPrototypeOf(decodePackedMetadata(plan!.table))).toBe(Object.prototype);
});

test("cycles, sparse arrays, invalid numbers and unsupported values safely reject selection", () => {
  const cycle: Record<string, unknown> = { bindings: [] };
  cycle.self = cycle;
  const sparse = { bindings: Array(2) };
  const cases = [
    cycle,
    sparse,
    { bindings: [], value: Number.POSITIVE_INFINITY },
    { bindings: [], value: -0 },
    { bindings: [], value: undefined },
    { bindings: [], value: 1n },
  ] as const;

  for (const reflection of cases) {
    expect(selectPackedReflection(reflection as Parameters<typeof selectPackedReflection>[0])).toBeNull();
    expect(selectInlinePackedReflection(reflection as Parameters<typeof selectPackedReflection>[0])).toBeNull();
  }
});

test("toJSON hooks are never invoked", () => {
  let calls = 0;
  const reflection = {
    bindings: [],
    toJSON() {
      calls++;
      return {};
    },
  } as unknown as Parameters<typeof selectPackedReflection>[0];

  expect(selectPackedReflection(reflection)).toBeNull();
  expect(selectInlinePackedReflection(reflection)).toBeNull();
  expect(calls).toBe(0);
});

test("the guard stops serializing layouts after the second distinct qualifying key", () => {
  const reflection = prepareShader(layoutShader([16, 17, 18]), "/early-stop.wgsl").reflection;
  const layouts = new Set(reflection.bindings.map((binding) => binding.layout));
  const serialized: unknown[] = [];
  const original = packedEncoding.packedDataKey;
  const spy = vi.spyOn(packedEncoding, "packedDataKey").mockImplementation((value) => {
    if (layouts.has(value as any)) serialized.push(value);
    return original(value);
  });
  try {
    expect(selectInlinePackedReflection(reflection)).not.toBeNull();
    expect(serialized).toEqual([reflection.bindings[0]!.layout, reflection.bindings[1]!.layout]);
  } finally {
    spy.mockRestore();
  }
});

function layoutShader(memberCounts: readonly number[]): string {
  const structs = memberCounts.map((memberCount, structIndex) => {
    const members = Array.from({ length: memberCount }, (_, memberIndex) => {
      const type = memberIndex % 3 === 0
        ? "mat4x4f"
        : memberIndex % 3 === 1
        ? "array<vec4f, 4>"
        : "vec4f";
      return `m${structIndex}_${memberIndex}: ${type},`;
    }).join("\n");
    return `struct Params${structIndex} {\n${members}\n}`;
  }).join("\n");
  const bindings = memberCounts.map((_, index) =>
    `@group(0) @binding(${index}) var<uniform> params${index}: Params${index};`
  ).join("\n");
  const uses = memberCounts.map((_, index) => `_ = params${index}.m${index}_0;`).join("\n");
  return `${structs}\n${bindings}\n@compute @workgroup_size(1) fn main() {\n${uses}\n}`;
}

function repeatedTypeShader(memberCount: number, bindingCount: number): string {
  const source = layoutShader([memberCount]);
  const structEnd = source.indexOf("@group");
  const struct = source.slice(0, structEnd);
  const bindings = Array.from({ length: bindingCount }, (_, index) =>
    `@group(0) @binding(${index}) var<uniform> params${index}: Params0;`
  ).join("\n");
  return `${struct}${bindings}\n@compute @workgroup_size(1) fn main() { _ = params0.m0_0; }`;
}

function addressSpaceShader(addressSpaces: readonly ("uniform" | "storage")[]): string {
  const source = layoutShader(addressSpaces.map(() => 16));
  const structEnd = source.indexOf("@group");
  const structs = source.slice(0, structEnd);
  const bindings = addressSpaces.map((addressSpace, index) =>
    `@group(0) @binding(${index}) var<${addressSpace}${addressSpace === "storage" ? ", read" : ""}> params${index}: Params${index};`
  ).join("\n");
  return `${structs}${bindings}\n@compute @workgroup_size(1) fn main() { _ = params0.m0_0; }`;
}

function exactLayout(bytes: number, identity = ""): { readonly identity: string; readonly padding: string } {
  const empty = { identity, padding: "" };
  const emptyBytes = Buffer.byteLength(packedDataKey(empty)!, "utf8");
  const layout = { identity, padding: "x".repeat(bytes - emptyBytes) };
  if (Buffer.byteLength(packedDataKey(layout)!, "utf8") !== bytes) throw new Error("layout key size drifted");
  return layout;
}

function replaceLayout(reflection: ReturnType<typeof prepareShader>["reflection"], index: number, layout: unknown): void {
  (reflection.bindings[index] as { layout?: unknown }).layout = layout;
}

function uniformBinding(layout: unknown): Record<string, unknown> {
  return { kind: "buffer", addressSpace: "uniform", layout };
}

function reflectionWithBindings(bindings: readonly unknown[]): ReturnType<typeof prepareShader>["reflection"] {
  const reflection = structuredClone(prepareShader(layoutShader([16, 17]), "/guard-budget.wgsl").reflection);
  (reflection as unknown as { bindings: readonly unknown[] }).bindings = bindings;
  return reflection;
}
