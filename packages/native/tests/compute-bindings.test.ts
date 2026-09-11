import { expect, test } from "vitest";
import { generateMetalPackage, type MetalCompute } from "../src/index.ts";
import {
  computePackageInput,
  sizeTablePackageInput,
} from "./compute-bindings-fixture.ts";

function generateCompute(compute: unknown) {
  const input = computePackageInput();
  return generateMetalPackage({
    ...input,
    programs: [{ ...input.programs[0], compute: compute as MetalCompute }],
  });
}

test("compute metadata must completely describe one supported storage-only stage before generating source", () => {
  const input = computePackageInput();
  const program = input.programs[0];
  const compute = program.compute;
  const storage = compute.storage[0];
  for (const malformed of [
    null,
    {},
    { ...compute, extra: true },
    ...[0, -1, 1.5, NaN, 0x100000000].map((x) => ({
      ...compute,
      workgroupSize: { x, y: 1, z: 1 },
    })),
    { ...compute, workgroupSize: { x: 1, y: 1 } },
    { ...compute, storage: null },
    ...[
      { ...storage, name: 'bad"Name' },
      { ...storage, access: "write" },
      { ...storage, runtimeSized: "yes" },
      { ...storage, minimumBindingSize: 0 },
      { ...storage, minimumBindingSize: 0x100000000 },
      { ...storage, alignment: 3 },
      { ...storage, slots: [] },
      { ...storage, slots: [{ stage: "vertex", index: 0 }] },
      { ...storage, slots: [{ stage: "compute", index: -1 }] },
      { ...storage, slots: [{ stage: "compute", index: 30 }] },
      { ...storage, slots: [{ stage: "compute", index: 1.5 }] },
      { ...storage, slots: [{ stage: "compute", index: 0, extra: true }] },
    ].map((binding) => ({ ...compute, storage: [binding] })),
    { ...compute, storage: [storage, { ...storage, name: "other" }] },
    {
      ...compute,
      storage: [
        storage,
        { ...storage, name: "VALUES", slots: [{ stage: "compute", index: 1 }] },
      ],
    },
  ]) {
    expect(() => generateCompute(malformed)).toThrow();
  }
  expect(() =>
    generateMetalPackage({
      ...input,
      programs: [{ ...program, functions: { fragment: "fragment_main" } }],
    })
  ).toThrow(/compute/);
  expect(() =>
    generateMetalPackage({
      ...input,
      programs: [
        {
          ...program,
          uniforms: [
            {
              name: "params",
              typeName: "Params",
              byteCount: 4,
              alignment: 4,
              members: [{ name: "value", type: "f32", offset: 0 }],
            },
          ],
        },
      ],
    })
  ).toThrow(/compute/);
});

test("internal data requires one effective canonical size region with participating runtime storage", () => {
  const compute = sizeTablePackageInput().programs[0]!.compute!;
  const payload = compute.internalData[0]!;
  for (const internalData of [
    [{ ...payload, byteOffset: 8 }],
    null,
    {},
    [payload, payload],
    [{}],
    [{ ...payload, kind: "immediate-data" }],
    [{ ...payload, immediateDataLayoutModel: "unknown" }],
    [{ ...payload, storageBufferSizeModel: "unknown" }],
    [{ ...payload, slot: { stage: "fragment", index: 30 } }],
    [{ ...payload, slot: { stage: "compute", index: 29 } }],
    [{ ...payload, slot: { stage: "compute", index: 30, count: 1 } }],
    [{ ...payload, guessedBytes: [0] }],
  ]) {
    expect(() => generateCompute({ ...compute, internalData })).toThrow(
      /internalData/
    );
  }
  expect(() =>
    generateCompute({
      ...compute,
      storage: compute.storage.map((binding) => ({
        ...binding,
        runtimeSized: false,
      })),
    })
  ).toThrow(/internalData/);
  expect(() => generateCompute({ ...compute, internalData: [] })).not.toThrow();
});

test("compute helper identities cannot be shadowed by authored module, program, or storage names", () => {
  const input = computePackageInput();
  const program = input.programs[0];
  const compute = program.compute;
  for (const name of [
    "PreparedBindings",
    "Storage",
    "ShaderInternalBufferData",
    "MTLSize",
    "MTLComputeCommandEncoder",
  ]) {
    expect(() => generateMetalPackage({ ...input, moduleName: name })).toThrow(
      /moduleName/
    );
    expect(() =>
      generateMetalPackage({ ...input, programs: [{ ...program, name }] })
    ).toThrow(/name/);
    expect(() =>
      generateCompute({
        ...compute,
        storage: [{ ...compute.storage[0], name }],
      })
    ).toThrow(/name/);
  }
});

test("compute generation canonicalizes physical slot order without changing caller metadata", () => {
  const compute = sizeTablePackageInput().programs[0]!.compute!;
  const storage = Object.freeze(
    [...compute.storage]
      .reverse()
      .map((binding) =>
        Object.freeze({
          ...binding,
          slots: Object.freeze(binding.slots.map(Object.freeze)),
        })
      )
  );
  const frozen = Object.freeze({ ...compute, storage });
  expect(generateCompute(frozen)).toEqual(generateCompute(compute));
  expect(frozen.storage.map((binding) => binding.name)).toEqual([
    "output",
    "values",
  ]);
  const source = Buffer.from(
    generateCompute(frozen).files["Sources/AppShaders/Shaders.generated.swift"]!
  ).toString("utf8");
  expect(source).toContain(
    "public init(values: ShaderBufferRange, output: ShaderBufferRange)"
  );
  expect(() =>
    generateCompute({ ...compute, storage: [], internalData: [] })
  ).not.toThrow();
});
