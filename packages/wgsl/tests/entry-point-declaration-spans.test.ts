import { expect, test } from "vitest";
import {
  resolveShader,
  type WGSLEntryPointDeclaration,
} from "@vgpu/wgsl/runtime";

async function declarationsFor(
  source: string,
  minify: boolean = false
): Promise<readonly WGSLEntryPointDeclaration[]> {
  const resolved = await resolveShader({
    entry: "/entry.wgsl",
    modules: { "/entry.wgsl": source },
    minify,
    validate: false,
  });
  return resolved.ast.modules.find((module) => module.path === "/entry.wgsl")!
    .entryPointDeclarations;
}

test("entry-point declarations span every attribute through the closing body brace", async () => {
  const source = [
    "fn helper() {}",
    "  @diagnostic(off, derivative_uniformity)",
    "  @compute",
    "  @workgroup_size(1)",
    "  export fn simulate() {",
    "    if (true) {",
    "      helper();",
    "    }",
    "  }",
  ].join("\n");

  const declarations = await declarationsFor(source);
  expect(declarations).toEqual([
    {
      name: "simulate",
      stage: "compute",
      span: { start: { line: 2, column: 3 }, end: { line: 9, column: 4 } },
    },
  ]);
});

test("export before entry-point attributes is reflected and included in the span", async () => {
  const source = [
    "export",
    "@fragment",
    "fn shade() -> @location(0) vec4f {",
    "  return vec4f(1.0);",
    "}",
  ].join("\n");

  await expect(declarationsFor(source)).resolves.toEqual([
    {
      name: "shade",
      stage: "fragment",
      span: { start: { line: 1, column: 1 }, end: { line: 5, column: 2 } },
    },
  ]);
});

test("both export orders retain complete entry points in emitted WGSL", async () => {
  const source = [
    "@compute @workgroup_size(1) export fn simulate() {}",
    "export @fragment fn shade() -> @location(0) vec4f { return vec4f(1.0); }",
  ].join("\n");
  const resolved = await resolveShader({
    entry: "/entry.wgsl",
    modules: { "/entry.wgsl": source },
    validate: false,
  });

  expect(resolved.wgsl).toContain("fn simulate()");
  expect(resolved.wgsl).toContain("fn shade()");
  expect(resolved.wgsl).not.toContain("export");
});

test("export before attributes participates in duplicate entry-point detection", async () => {
  await expect(
    resolveShader({
      entry: "/entry.wgsl",
      validate: false,
      modules: {
        "/entry.wgsl":
          'import { helper } from "./library.wgsl";\n@compute @workgroup_size(1) fn main() {}',
        "/library.wgsl":
          "export fn helper() {}\nexport @compute @workgroup_size(1) fn main() {}",
      },
    })
  ).rejects.toMatchObject({ code: "VGPU-WGSL-ENTRYPOINT-DUP" });
});

test("columns are 1-based UTF-16 code-unit positions and end is exclusive", async () => {
  const source = "/* 😀 */  @compute @workgroup_size(1) fn unicode_column() {}";
  const [declaration] = await declarationsFor(source);

  expect(declaration?.span.start).toEqual({ line: 1, column: 11 });
  expect(declaration?.span.end).toEqual({ line: 1, column: source.length + 1 });
});

test("authored declaration spans are independent of emitted minification", async () => {
  const source =
    "\n  @vertex fn draw() -> @builtin(position) vec4f {\n    return vec4f(0.0);\n  }";

  expect(await declarationsFor(source, true)).toEqual(
    await declarationsFor(source, false)
  );
});
