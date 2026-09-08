import { expect, test } from "vitest";
import { generateMetalPackage, type MetalUniform } from "../src/index.ts";
import { bindingPackageInput } from "./metal-bindings-fixture.ts";

function generateSlots(slots: unknown) {
  const input = bindingPackageInput();
  const uniform = input.programs[0]!.uniforms![0]!;
  return generateMetalPackage({
    ...input,
    programs: [
      {
        ...input.programs[0]!,
        uniforms: [{ ...uniform, slots } as MetalUniform],
      },
    ],
  });
}

test("malformed or unsupported slot mappings cannot generate Metal setters", () => {
  for (const slots of [
    [],
    null,
    {},
    [null],
    [{}],
    [{ stage: "compute", index: 0 }],
    [{ stage: "fragment", index: -1 }],
    [{ stage: "fragment", index: 31 }],
    [{ stage: "fragment", index: 1.5 }],
    [{ stage: "fragment", index: NaN }],
    [{ stage: "fragment", index: Infinity }],
    [{ stage: "fragment", index: "0" }],
    [{ stage: "fragment", index: 0, guessed: true }],
  ]) {
    expect(() => generateSlots(slots)).toThrow(/slots/);
  }
});

test("ambiguous stage mappings and overlapping shader buffer slots are rejected", () => {
  for (const indices of [
    [3, 3],
    [3, 4],
  ]) {
    expect(() =>
      generateSlots(indices.map((index) => ({ stage: "fragment", index })))
    ).toThrow(/slots/);
  }
  const input = bindingPackageInput();
  const uniform = input.programs[0]!.uniforms![0]!;
  expect(() =>
    generateMetalPackage({
      ...input,
      programs: [
        {
          ...input.programs[0]!,
          uniforms: [
            uniform,
            {
              ...uniform,
              name: "zeta",
              slots: [{ stage: "fragment", index: 3 }],
            },
          ],
        },
      ],
    })
  ).toThrow(/slots/);
  expect(() =>
    generateMetalPackage({
      ...input,
      programs: [
        {
          ...input.programs[0]!,
          uniforms: [
            uniform,
            {
              ...uniform,
              name: "zeta",
              slots: [{ stage: "vertex", index: 3 }],
            },
          ],
        },
      ],
    })
  ).not.toThrow();
});

test("new binding declarations cannot be shadowed by authored Swift identities", () => {
  const input = bindingPackageInput();
  const program = input.programs[0]!;
  const uniform = program.uniforms![0]!;
  for (const name of [
    "Bindings",
    "ShaderBufferRange",
    "ShaderBufferSlot",
    "ShaderBindingError",
    "_ShaderBinding",
    "MTLBuffer",
    "MTLRenderCommandEncoder",
  ]) {
    expect(() => generateMetalPackage({ ...input, moduleName: name })).toThrow(
      /moduleName/
    );
    expect(() =>
      generateMetalPackage({ ...input, programs: [{ ...program, name }] })
    ).toThrow(/name/);
    expect(() =>
      generateMetalPackage({
        ...input,
        programs: [{ ...program, uniforms: [{ ...uniform, typeName: name }] }],
      })
    ).toThrow(/typeName/);
  }
});

test("packing-only metadata remains optional but mapped programs cannot be partial", () => {
  const input = bindingPackageInput();
  const program = input.programs[0]!;
  const uniform = program.uniforms![0]!;
  const { slots: _slots, ...packingOnly } = uniform;
  const packing = generateMetalPackage({
    ...input,
    programs: [{ ...program, uniforms: [packingOnly] }],
  });
  const text = Buffer.from(
    packing.files["Sources/AppShaders/Shaders.generated.swift"]!
  ).toString("utf8");
  expect(text).toContain("public func pack(");
  expect(text).not.toContain("public struct ShaderBufferRange");
  for (const uniforms of [
    [uniform, { ...packingOnly, name: "alternate" }],
    [packingOnly, { ...uniform, name: "alternate" }],
  ]) {
    expect(() =>
      generateMetalPackage({ ...input, programs: [{ ...program, uniforms }] })
    ).toThrow(/slots/);
  }
});

test("slots must belong to the selected render stages and never create a compute binder", () => {
  const input = bindingPackageInput();
  const program = input.programs[0]!;
  expect(() =>
    generateMetalPackage({
      ...input,
      programs: [{ ...program, functions: { fragment: "fragment_main" } }],
    })
  ).toThrow(/slots/);
  expect(() =>
    generateMetalPackage({
      ...input,
      programs: [{ ...program, functions: { compute: "compute_main" } }],
    })
  ).toThrow(/slots/);
  expect(() =>
    generateSlots([
      { stage: "vertex", index: 0 },
      { stage: "fragment", index: 30 },
    ])
  ).not.toThrow();
});

test("slot order is canonical and never mutates the caller's mapping", () => {
  const slots = Object.freeze(
    [
      { stage: "fragment", index: 3 },
      { stage: "vertex", index: 5 },
    ].map(Object.freeze)
  );
  expect(generateSlots(slots)).toEqual(generateSlots([...slots].reverse()));
  expect(slots.map(({ stage }) => stage)).toEqual(["fragment", "vertex"]);
});
