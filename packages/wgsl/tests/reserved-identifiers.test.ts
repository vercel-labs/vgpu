import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

const ENTRY = `@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }`;

async function diagnosticsFor(source: string, extra: Record<string, string> = {}) {
  const result = await resolveShader({ entry: "/entry.wgsl", validate: false, modules: { "/entry.wgsl": source, ...extra } });
  return result.diagnostics;
}

test("struct member named 'from' is reported (issue #192 repro)", async () => {
  const diagnostics = await diagnosticsFor(`struct Paint { from: vec2f, to: vec2f }\n${ENTRY}`);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    code: "VGPU-WGSL-RESERVED-IDENT",
    severity: "error",
    line: 1,
    column: 16,
    range: { file: "/entry.wgsl", start: { line: 1, column: 16 } },
  });
  expect(diagnostics[0]!.message).toBe("'from' is a reserved word in WGSL and cannot be used as an identifier; rename this struct member (for example 'from_')");
});

test("reserved words are reported at every declaration site", async () => {
  const diagnostics = await diagnosticsFor([
    "struct filter { new: f32 }",
    "alias self = f32;",
    "var<private> where: f32 = 0.0;",
    "override typeof: f32 = 1.0;",
    "fn match(shared: f32) -> f32 { var restrict = shared; let union = restrict; return union; }",
    ENTRY,
  ].join("\n"));
  expect(diagnostics.map((item) => item.message.split("'")[1])).toEqual([
    "filter", "new", "self", "where", "typeof", "match", "shared", "restrict", "union",
  ]);
  expect(new Set(diagnostics.map((item) => item.code))).toEqual(new Set(["VGPU-WGSL-RESERVED-IDENT"]));
});

test("reserved words are reported in imported modules with their own file location", async () => {
  const diagnostics = await diagnosticsFor(
    `import { paint } from "./paint.wgsl";\n@fragment fn main() -> @location(0) vec4f { return vec4f(paint()); }`,
    { "/paint.wgsl": "export struct Brush {\n  interface: f32,\n}\nexport fn paint() -> f32 { return 1.0; }" },
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "VGPU-WGSL-RESERVED-IDENT", line: 2, range: { file: "/paint.wgsl" } });
  expect(diagnostics[0]!.message).toContain("'interface' is a reserved word in WGSL");
});

test("WGSL keywords used as declared names are reported as keywords", async () => {
  const diagnostics = await diagnosticsFor(`struct S { loop: f32 }\n${ENTRY}`);
  expect(diagnostics[0]!.message).toBe("'loop' is a keyword in WGSL and cannot be used as an identifier; rename this struct member (for example 'loop_')");
});

test("valid identifiers and vgpu module syntax produce no diagnostics", async () => {
  const diagnostics = await diagnosticsFor(
    [
      `import { helper } from "./helper.wgsl";`,
      "struct Paint { start: vec2f, end: vec2f, from_: f32 }",
      "alias Scalar = f32;",
      "@group(0) @binding(0) var<uniform> paint: Paint;",
      "override intensity: f32 = 1.0;",
      "fn mixColors(@location(0) first: vec4f, second: vec4f) -> vec4f {",
      "  var total = first + second;",
      "  for (var i = 0; i < 2; i++) { total = total * 0.5; }",
      "  let scaled: Scalar = helper(intensity);",
      "  return total * scaled * paint.start.x;",
      "}",
      "@fragment fn main() -> @location(0) vec4f { return mixColors(vec4f(1.0), vec4f(2.0)); }",
    ].join("\n"),
    { "/helper.wgsl": "export fn helper(value: f32) -> f32 { return value; }" },
  );
  expect(diagnostics).toEqual([]);
});

test("identifiers that merely contain a reserved word are not reported", async () => {
  expect(await diagnosticsFor(`struct S { fromEdge: f32, transform: f32, newValue: f32 }\n${ENTRY}`)).toEqual([]);
});

test("predeclared type and builtin names stay legal identifiers", async () => {
  expect(await diagnosticsFor(`struct S { position: vec4f, length: f32 }\n${ENTRY}`)).toEqual([]);
});

test("nested type templates do not desynchronize the member walk", async () => {
  const diagnostics = await diagnosticsFor([
    "struct S {",
    "  corners: array<vec4<f32>, 4>,",
    "  weights: array<mat2x2<f32>, 2>,",
    "  from: f32,",
    "  tail: u32,",
    "}",
    ENTRY,
  ].join("\n"));
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ line: 4, column: 3 });
  expect(diagnostics[0]!.message).toContain("'from'");
});

test("attributes with expression arguments do not hide the declared name", async () => {
  const diagnostics = await diagnosticsFor([
    "const SIZE: u32 = 4u;",
    "struct S {",
    "  @align(16) @size(32) valid: vec4f,",
    "  @align(4 * 2) from: f32,",
    "}",
    "@fragment fn main(@location(0) @interpolate(flat) new: f32) -> @location(0) vec4f { return vec4f(new); }",
  ].join("\n"));
  expect(diagnostics.map((item) => item.message.split("'")[1])).toEqual(["from", "new"]);
  expect(diagnostics[0]).toMatchObject({ line: 4, column: 17 });
});

test("comments between declaration tokens do not shift reported locations", async () => {
  const diagnostics = await diagnosticsFor([
    "struct /* here */ S {",
    "  // a member follows",
    "  from: f32, /* trailing */ to: f32,",
    "}",
    "fn /* name */ where() -> f32 { return 1.0; }",
    ENTRY,
  ].join("\n"));
  expect(diagnostics.map((item) => item.message.split("'")[1])).toEqual(["from", "where"]);
  expect(diagnostics[0]).toMatchObject({ line: 3, column: 3 });
  expect(diagnostics[1]).toMatchObject({ line: 5, column: 15 });
});
