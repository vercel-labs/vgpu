import { expect, test } from "vitest";
import { generateMetalPackage, type MetalUniform } from "../src/index.ts";
import { uniformPackageInput } from "./uniform-fixture.ts";

function generateWith(uniform: MetalUniform) {
  const input = uniformPackageInput();
  return generateMetalPackage({ ...input, programs: [{ ...input.programs[0]!, uniforms: [uniform] }] });
}

test("overlapping uniform fields are rejected instead of generating corrupt packers", () => {
  const uniform = uniformPackageInput().programs[0]!.uniforms![0]!;
  expect(() => generateWith({
    ...uniform,
    members: uniform.members.map((member) => member.name === "gain" ? { ...member, offset: 8 } : member),
  })).toThrow(/overlap/);
});

test("uniform sizes and offsets must describe a bounded aligned physical layout", () => {
  const uniform = uniformPackageInput().programs[0]!.uniforms![0]!;
  for (const byteCount of [0, 24, -1, 32.5, NaN, Infinity, 2 ** 40]) {
    expect(() => generateWith({ ...uniform, byteCount })).toThrow(/uniforms/);
  }
  for (const alignment of [0, 3, 8, 32.5, NaN, Infinity, 2 ** 40]) {
    expect(() => generateWith({ ...uniform, alignment })).toThrow(/uniforms/);
  }
  for (const offset of [17, 20, 32, 16.5, NaN, Infinity]) {
    expect(() => generateWith({ ...uniform, members: uniform.members.map((member) =>
      member.name === "phase" ? { ...member, offset } : member
    ) })).toThrow(/uniforms/);
  }
});

test("uniform identities cannot inject Swift or collide with generated declarations", () => {
  const uniform = uniformPackageInput().programs[0]!.uniforms![0]!;
  for (const name of ["", "class", "a/b", "x() {}", "__Internal", "_Layout_params"]) {
    expect(() => generateWith({ ...uniform, name })).toThrow(/uniforms/);
  }
  for (const typeName of ["", "struct", "Float", "Uniforms", "Functions", "Gradient", "_ShaderPacking", "ShaderPackingError"]) {
    expect(() => generateWith({ ...uniform, typeName })).toThrow(/uniforms/);
  }
  for (const name of ["", "self", "two words", "x: Float"]) {
    expect(() => generateWith({ ...uniform, members: [{ name, type: "f32", offset: 0 }] })).toThrow(/uniforms/);
  }
  expect(() => generateWith({ ...uniform, members: [
    { name: "field", type: "f32", offset: 0 },
    { name: "field", type: "f32", offset: 4 },
  ] })).toThrow(/uniforms/);
});

test("malformed or unsupported uniform metadata fails with a binding diagnostic", () => {
  const input = uniformPackageInput();
  const uniform = input.programs[0]!.uniforms![0]!;
  for (const uniforms of [null, {}, [null], [{ ...uniform, members: null }],
    [{ ...uniform, members: [] }], [{ ...uniform, members: [null] }],
    [{ ...uniform, members: [{ name: "field", type: "mat4x4f", offset: 0 }] }],
    [{ ...uniform, members: [{ name: "field", type: "toString", offset: 0 }] }],
  ]) {
    expect(() => generateMetalPackage({ ...input, programs: [{ ...input.programs[0]!, uniforms } as never] })).toThrow(/uniforms/);
  }
});

test("binding names and shared Swift type identities must be unambiguous", () => {
  const input = uniformPackageInput();
  const uniform = input.programs[0]!.uniforms![0]!;
  for (const alternate of [
    { ...uniform },
    { ...uniform, name: "PARAMS" },
    { ...uniform, name: "alternate", typeName: "PARAMS" },
    { ...uniform, name: "alternate", members: [{ name: "different", type: "f32" as const, offset: 0 }] },
  ]) {
    expect(() => generateMetalPackage({ ...input, programs: [{
      ...input.programs[0]!, uniforms: [uniform, alternate],
    }] })).toThrow(/uniforms/);
  }
});

test("uniform declaration order is canonical without mutating the caller's bindings", () => {
  const input = uniformPackageInput();
  const uniform = input.programs[0]!.uniforms![0]!;
  const alternate = { ...uniform, name: "alternate", typeName: "AlternateParams" };
  const generateOrder = (uniforms: readonly MetalUniform[]) => generateMetalPackage({
    ...input, programs: [{ ...input.programs[0]!, uniforms }],
  });
  const uniforms = Object.freeze([uniform, alternate]);
  const first = generateOrder(uniforms);
  expect(generateOrder([alternate, uniform])).toEqual(first);
  expect(uniforms).toEqual([uniform, alternate]);
});
