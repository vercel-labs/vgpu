import { expect, test } from "vitest";
import { prepareShader } from "@vgpu/wgsl/prepare";
import { reflectSource } from "@vgpu/wgsl/reflect-source";

test("prepares an exact WGSL string with the default producer contract", () => {
  const wgsl = "@compute @workgroup_size(1) fn main() {}\n";

  const prepared = prepareShader(wgsl);

  expect(prepared).toMatchObject({
    version: 2,
    wgsl,
    producer: "@vgpu/wgsl/prepare-v2",
    reflection: {
      entryPoints: [
        {
          name: "main",
          stage: "compute",
          workgroupSize: [1, 1, 1],
          bindings: [],
          samplingPairs: [],
        },
      ],
    },
  });
  expect(prepared).not.toHaveProperty("functionExports");
  expect(prepared.sourceChecksum).toMatch(/^fnv1a64-utf16le-v1:[0-9a-f]{16}$/u);
});

test("preserves an explicitly empty function-export list from object input", () => {
  const prepared = prepareShader({
    wgsl: "@compute @workgroup_size(1) fn main() {}",
    functionExports: [],
  });

  expect(prepared.functionExports).toEqual([]);
  expect(prepared).toHaveProperty("functionExports");
});

test("copies function-export records while keeping duplicate authored names", () => {
  const firstParameters = ["position"];
  const first = {
    name: "shade",
    resolvedName: "shadeA",
    parameterNames: firstParameters,
  };
  const functionExports = [
    first,
    { name: "shade", resolvedName: "shadeB", parameterNames: ["normal"] },
  ];
  const input = { wgsl: "fn shadeA(position: vec3f) {}", functionExports };

  const prepared = prepareShader(input);
  first.name = "mutated";
  firstParameters[0] = "mutated";
  functionExports.pop();

  expect(prepared.functionExports).toEqual([
    { name: "shade", resolvedName: "shadeA", parameterNames: ["position"] },
    { name: "shade", resolvedName: "shadeB", parameterNames: ["normal"] },
  ]);
});

test("serializes nonfinite workgroup axes without wire nulls", () => {
  const literal = prepareShader("@compute @workgroup_size(8, 2, 1) fn main() {}");
  const suffixed = prepareShader("@compute @workgroup_size(8u, 2, 1) fn main() {}");
  const symbolic = prepareShader("override WIDTH: u32; @compute @workgroup_size(WIDTH, 2, 1) fn main() {}");

  expect(literal.reflection.entryPoints[0]?.workgroupSize).toEqual([8, 2, 1]);
  expect(suffixed.reflection.entryPoints[0]?.workgroupSize).toEqual(["unresolved", 2, 1]);
  expect(symbolic.reflection.entryPoints[0]?.workgroupSize).toEqual(["unresolved", 2, 1]);
  expect(JSON.stringify({ suffixed, symbolic })).not.toContain("null");
  expect(structuredClone(symbolic)).toEqual(symbolic);
});

test("preserves the complete reflection shape through JSON and structured cloning", () => {
  const wgsl = `
    enable f16;
    alias Scalar = f32;
    struct Params { gain: Scalar, values: array<vec2f, 2> }
    @group(0) @binding(0) var<uniform> params: Params;
    @group(0) @binding(1) var tex: texture_2d<f32>;
    @group(0) @binding(2) var smp: sampler;
    @id(7) override SCALE: f32 = 1.0;
    @vertex fn vs(@location(0) position: vec2f) -> @builtin(position) vec4f {
      return vec4f(position * params.gain, 0.0, 1.0);
    }
    @fragment fn fs() -> @location(0) vec4f {
      return textureSample(tex, smp, vec2f(0.5)) * SCALE;
    }
  `;
  const prepared = prepareShader(wgsl);
  const expected = JSON.parse(JSON.stringify(reflectSource(wgsl)));

  expect(prepared.reflection).toEqual(expected);
  expect(JSON.parse(JSON.stringify(prepared))).toEqual(prepared);
  expect(structuredClone(prepared)).toEqual(prepared);
});

test("checksums exact UTF-16 code units with fixed FNV-1a vectors", () => {
  const vectors = [
    ["", "fnv1a64-utf16le-v1:cbf29ce484222325"],
    ["\r\n", "fnv1a64-utf16le-v1:2d011698a05df6b2"],
    ["// café", "fnv1a64-utf16le-v1:13dd75f9ae4a4218"],
    ["// 😀", "fnv1a64-utf16le-v1:7d409d963d0bc9ca"],
    ["// \ud800", "fnv1a64-utf16le-v1:a8dbb29252a528a5"],
    ["// \udc00", "fnv1a64-utf16le-v1:a8dbae9252a521d9"],
  ] as const;

  for (const [wgsl, checksum] of vectors) {
    expect(prepareShader(wgsl).sourceChecksum, JSON.stringify(wgsl)).toBe(checksum);
  }
});

test("uses the default and custom paths in unchanged reflection diagnostics", () => {
  for (const [path, expectedPath] of [
    [undefined, "<runtime>"],
    ["shaders/custom.wgsl", "shaders/custom.wgsl"],
  ] as const) {
    try {
      prepareShader("fn café() {}", path);
      throw new Error("expected reflection to reject a non-ASCII identifier");
    } catch (error) {
      expect(error).toMatchObject({ code: "VGPU-WGSL-IDENT-NONASCII" });
      expect(String(error)).toContain(expectedPath);
    }
  }
});

test("keeps reflectSource import diagnostics and resolver guidance", () => {
  try {
    prepareShader('import { color } from "./palette.wgsl";');
    throw new Error("expected preparation to reject an import graph");
  } catch (error) {
    expect(error).toMatchObject({ code: "VGPU-WGSL-REFLECT-SOURCE-IMPORT" });
    expect(String(error)).toContain("resolveShader()");
  }
});

test("rejects invalid source, path, and function-export shapes without running getters", () => {
  let getterCalls = 0;
  const wgslAccessor = Object.defineProperty({}, "wgsl", {
    get() {
      getterCalls++;
      return "";
    },
  });
  const exportsAccessor = Object.defineProperties({}, {
    wgsl: { value: "", enumerable: true },
    functionExports: {
      get() {
        getterCalls++;
        return [];
      },
    },
  });
  const exportRecordAccessor = Object.defineProperty({}, "name", {
    get() {
      getterCalls++;
      return "shade";
    },
  });
  Object.defineProperties(exportRecordAccessor, {
    resolvedName: { value: "shade" },
    parameterNames: { value: [] },
  });
  const sparseExports = Array(1);
  const accessorExports: unknown[] = [];
  Object.defineProperty(accessorExports, "0", {
    get() {
      getterCalls++;
      return {};
    },
  });
  accessorExports.length = 1;
  const sparseParameters = Array(1);

  const invalidSources: unknown[] = [
    undefined,
    null,
    1,
    [],
    {},
    Object.create({ wgsl: "" }),
    { wgsl: 1 },
    wgslAccessor,
    { wgsl: "", functionExports: undefined },
    exportsAccessor,
    { wgsl: "", functionExports: {} },
    { wgsl: "", functionExports: sparseExports },
    { wgsl: "", functionExports: accessorExports },
    { wgsl: "", functionExports: [null] },
    { wgsl: "", functionExports: [exportRecordAccessor] },
    { wgsl: "", functionExports: [{ name: "shade", resolvedName: "shade", parameterNames: sparseParameters }] },
    { wgsl: "", functionExports: [{ name: "shade", resolvedName: "shade", parameterNames: ["value", "value"] }] },
    { wgsl: "", functionExports: [{ name: "fn", resolvedName: "shade", parameterNames: [] }] },
  ];

  for (const source of invalidSources) {
    expectInvalid(() => prepareShader(source as never));
  }
  for (const path of [null, 1, ""] as const) {
    expectInvalid(() => prepareShader("", path as never));
  }
  expect(getterCalls).toBe(0);
});

test("ignores legacy and additive metadata without inspecting it", () => {
  let getterCalls = 0;
  const functionExport = {
    name: "shade",
    resolvedName: "shade",
    parameterNames: [],
  };
  Object.defineProperty(functionExport, "metadata", {
    get() {
      getterCalls++;
      throw new Error("additive metadata must be ignored");
    },
  });
  const source = { wgsl: "fn shade() {}", functionExports: [functionExport] };
  for (const key of ["version", "reflection", "sourceChecksum", "producer"] as const) {
    Object.defineProperty(source, key, {
      get() {
        getterCalls++;
        throw new Error(`legacy ${key} must be ignored`);
      },
    });
  }

  expect(prepareShader(source).functionExports).toEqual([
    { name: "shade", resolvedName: "shade", parameterNames: [] },
  ]);
  expect(getterCalls).toBe(0);
});

function expectInvalid(action: () => unknown): void {
  try {
    action();
    throw new Error("expected VGPU-SHADER-SOURCE-INVALID");
  } catch (error) {
    expect(error).toMatchObject({ code: "VGPU-SHADER-SOURCE-INVALID" });
  }
}
