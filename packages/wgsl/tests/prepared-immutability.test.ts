import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { prepareShader } from "../src/prepare.ts";
import { reflectSource } from "../src/runtime/reflect-source.ts";
import { resolveShader } from "../src/runtime/resolve-shader.ts";
import { packedModuleAssets } from "../src/loader-shared/packed-query.ts";
import {
  shaderSourceModule,
  shaderSourceModuleWithPackedImports,
  type PackedImportMode,
} from "../src/loader-shared/emit.ts";
import type { ShaderSource } from "../src/types.ts";
import { evaluateShaderModule } from "./helpers/evaluate-shader-module.ts";

const LEAF = `struct Params { tint: vec4f }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs_main() -> @location(0) vec4f { return params.tint; }
`;
const PACKED = layoutShader(8);
const WEBPACK_LOADER = "/installed/@vgpu/wgsl/loader-webpack.js";

test("prepareShader() returns a deeply frozen artifact for every input form", async () => {
  const functionExports = [{ name: "tint", resolvedName: "tint_1", parameterNames: ["color"] }];
  const dir = await mkdtemp(join(tmpdir(), "vgpu-prepared-immutability-"));
  const entry = join(dir, "entry.wgsl");
  await writeFile(entry, `export fn shade(value: f32) -> f32 { return value; }\n${LEAF}`);
  const resolved = await resolveShader({ entry });

  for (const artifact of [prepareShader(LEAF), prepareShader({ wgsl: LEAF, functionExports }), prepareShader(resolved, entry)]) {
    expect(isDeeplyFrozen(artifact)).toBe(true);
    expectWritesRejected(artifact);
  }
  const fromResolved = prepareShader(resolved, entry);
  expect(fromResolved.functionExports).toEqual(resolved.functionExports);
  expect(fromResolved.functionExports).not.toBe(resolved.functionExports);
  expect(Object.isFrozen(resolved.functionExports)).toBe(false);
});

test("prepareShader() copies caller-owned functionExports and never freezes or aliases them", () => {
  const parameterNames = ["color"];
  const record = { name: "tint", resolvedName: "tint_1", parameterNames };
  const functionExports = [record];
  const artifact = prepareShader({ wgsl: LEAF, functionExports });

  expect(Object.isFrozen(functionExports)).toBe(false);
  expect(Object.isFrozen(record)).toBe(false);
  expect(Object.isFrozen(parameterNames)).toBe(false);
  expect(artifact.functionExports).not.toBe(functionExports);
  expect(artifact.functionExports?.[0]).not.toBe(record);
  expect(artifact.functionExports?.[0]?.parameterNames).not.toBe(parameterNames);
  parameterNames.push("later");
  record.name = "renamed";
  expect(artifact.functionExports).toEqual([{ name: "tint", resolvedName: "tint_1", parameterNames: ["color"] }]);
});

test("freezing prepared output leaves the cached reflection unfrozen", () => {
  const artifact = prepareShader(LEAF, "/cached.wgsl");
  const cached = reflectSource(LEAF, "/cached.wgsl");

  expect(isDeeplyFrozen(artifact)).toBe(true);
  expect(Object.isFrozen(cached)).toBe(false);
  expect(Object.isFrozen(cached.bindings)).toBe(false);
});

const MODES: readonly { readonly name: string; readonly mode: PackedImportMode }[] = [
  { name: "standard", mode: { kind: "standard" } },
  { name: "inline (default decoder)", mode: { kind: "inline" } },
  { name: "inline (explicit decoder)", mode: { kind: "inline", decoder: packedModuleAssets().decoder } },
  { name: "webpack", mode: { kind: "webpack", webpackLoader: WEBPACK_LOADER } },
  { name: "plain", mode: { kind: "plain" } },
];

test.each(MODES.flatMap(({ name, mode }) => [
  { name, mode, form: "literal", source: LEAF },
  { name, mode, form: mode.kind === "plain" ? "plain literal" : "packed", source: PACKED },
]))("$name $form modules export a deeply frozen artifact equal to prepareShader()", async ({ mode, form, source }) => {
  const path = `/fixtures/immutability-${form.replaceAll(" ", "-")}.wgsl`;
  const code = shaderSourceModuleWithPackedImports(source, path, [], mode);
  const prepared = prepareShader({ wgsl: source, functionExports: [] }, path);
  const artifact = await evaluate(code);

  expect(code.includes("decodePackedMetadata")).toBe(form === "packed");
  expect(isDeeplyFrozen(artifact)).toBe(true);
  expect(artifact).toStrictEqual(prepared);
  expect(Object.keys(artifact)).toEqual(Object.keys(prepared));
  expect(Object.keys(artifact.reflection)).toEqual(Object.keys(prepared.reflection));
  expect(artifact.sourceChecksum).toBe(prepared.sourceChecksum);
  expect(artifact.producer).toBe("@vgpu/wgsl/prepare-v2");
  expectWritesRejected(artifact);

  const copy = structuredClone(artifact) as any;
  expect(Object.isFrozen(copy)).toBe(false);
  expect(Object.isFrozen(copy.reflection.bindings[0])).toBe(false);
  expect(copy).toStrictEqual(artifact);
  copy.reflection.bindings[0].name = "copy-only";
  expect(artifact.reflection.bindings[0]?.name).not.toBe("copy-only");

  const imports = [...code.matchAll(/^import .+ from "(.+)";$/gmu)].map((match) => match[1]!);
  if (form === "packed") {
    expect(imports[0]).toBe(mode.kind === "inline" && mode.decoder !== undefined ? mode.decoder : packedModuleAssets().decoder);
    expect(imports.slice(1).every((specifier) => specifier.includes("metadata.wgsl?__vgpu_packed_v1="))).toBe(true);
  } else {
    expect(imports).toEqual([]);
    expect(code).not.toMatch(/^\s*import\b/mu);
  }
  expect(code).not.toMatch(/prepareShader|reflectSource|scanner|parser|resolver|packed-selection|packed-query/u);
});

test("the default loader module form freezes deeply and keeps the existing module shape", async () => {
  const code = shaderSourceModule(LEAF, "/fixtures/default.wgsl", [{ name: "tint", resolvedName: "tint_1", parameterNames: ["color"] }]);
  const artifact = await evaluate(code);

  expect(isDeeplyFrozen(artifact)).toBe(true);
  expect(artifact.functionExports).toEqual([{ name: "tint", resolvedName: "tint_1", parameterNames: ["color"] }]);
  expect(code).toMatch(/export default \/\* @__PURE__ \*\//u);
  expect(code.match(/export default/gu)).toHaveLength(1);
});

test("the emitted freeze helper handles own __proto__ keys and arrays and freezes nothing outside the artifact", async () => {
  const code = shaderSourceModule(LEAF, "/fixtures/helper.wgsl", []);
  const helper = code.slice(0, code.indexOf("export default"));
  const probe = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(`${helper}
const outside = { untouched: true };
const value = JSON.parse('{"__proto__":{"nested":[1,{"deep":true}]},"list":[[1],[{"x":1}]]}');
export default { value, outside, result: _vgpuFreeze(value), prototypeFrozen: Object.isFrozen(Object.prototype) };
`).toString("base64")}`) as { default: { value: any; outside: object; result: unknown; prototypeFrozen: boolean } };
  const { value, outside, result, prototypeFrozen } = probe.default;

  expect(result).toBe(value);
  expect(Object.hasOwn(value, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(isDeeplyFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.__proto__.nested[1])).toBe(true);
  expect(Object.isFrozen(outside)).toBe(false);
  expect(prototypeFrozen).toBe(false);
});

async function evaluate(code: string): Promise<ShaderSource> {
  // The test evaluator serves packed metadata modules directly; drop webpack's inline loader prefix.
  return evaluateShaderModule(code.replaceAll(`"!!${WEBPACK_LOADER}!`, '"'));
}

function expectWritesRejected(artifact: ShaderSource): void {
  const mutable = artifact as any;
  expect(() => { mutable.wgsl = ""; }).toThrow(TypeError);
  expect(() => { mutable.extra = true; }).toThrow(TypeError);
  expect(() => { mutable.reflection.bindings.push({}); }).toThrow(TypeError);
  expect(() => { mutable.reflection.entryPoints[0].name = "renamed"; }).toThrow(TypeError);
  if (mutable.functionExports?.[0]) {
    expect(() => { mutable.functionExports[0].parameterNames[0] = "renamed"; }).toThrow(TypeError);
  }
  if (mutable.functionExports) expect(() => { mutable.functionExports.push({}); }).toThrow(TypeError);
}

function isDeeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((nested) => isDeeplyFrozen(nested, seen));
}

function layoutShader(memberCount: number, bindingCount = 4): string {
  const members = Array.from({ length: memberCount }, (_, index) => {
    const type = index % 3 === 0 ? "mat4x4f" : index % 3 === 1 ? "array<vec4f, 4>" : "vec4f";
    return `m${index}: ${type},`;
  }).join("\n");
  const bindings = Array.from({ length: bindingCount }, (_, index) =>
    `@group(0) @binding(${index}) var<uniform> params${index}: Params;`).join("\n");
  return `struct Params {\n${members}\n}
${bindings}
@compute @workgroup_size(1) fn main() { let value = params0.m0; }`;
}
