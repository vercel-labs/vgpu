import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ShaderFunctionExport, ShaderSource } from "@vgpu/wgsl";
import { transformWgsl } from "@vgpu/wgsl/loader-vite";
import wgslWebpackLoader from "@vgpu/wgsl/loader-webpack";

type EmittedShaderSource = ShaderSource & {
  readonly functionExports: readonly ShaderFunctionExport[];
};

const importGraphLoaders = [
  ["Vite", async (source: string, entry: string) => artifact(await transformWgsl(source, entry))],
  ["webpack", async (source: string, entry: string) => artifact((await webpack(source, entry)).code)],
] as const;

test("ordinary leaf artifacts preserve WGSL and authoritatively expose no function exports", async () => {
  const source = `// ordinary leaf\n@compute @workgroup_size(1) fn main() {\n  var value = 1u;\n}\n`;
  const vite = artifact(await transformWgsl(source, "/ordinary-vite.wgsl"));
  const webpackCode = wgslWebpackLoader.call({ resourcePath: "/ordinary-webpack.wgsl" }, source);

  expect(typeof webpackCode).toBe("string");
  const webpack = artifact(webpackCode ?? "");
  for (const emitted of [vite, webpack]) {
    expect(emitted.wgsl).toBe(source);
    expect(emitted.functionExports).toEqual([]);
  }
});

test("direct-export leaf artifacts resolve their in-memory source before identifier minification", async () => {
  const source = `export fn surfaceValue(authoredValue: f32) -> f32 { return authoredValue * 2.0; }`;
  const vite = artifact(await transformWgsl(source, "/missing/exported-vite.wgsl", { minify: true }));
  const webpackResult = await webpack(source, "/missing/exported-webpack.wgsl", { minify: true });
  const webpackArtifact = artifact(webpackResult.code);

  expect(webpackResult.synchronous).toBe(false);
  for (const emitted of [vite, webpackArtifact]) {
    expect(emitted.functionExports).toEqual([
      {
        name: "surfaceValue",
        resolvedName: expect.any(String),
        parameterNames: ["authoredValue"],
      },
    ]);
    expect(emitted.wgsl).not.toMatch(/\bexport\b/u);
    expect(emitted.wgsl).not.toContain("authoredValue");
    expect(emitted.wgsl).toMatch(functionDeclaration(emitted.functionExports[0]!.resolvedName));
  }
});

test("direct-export leaf DCE removes attributes attached through comment trivia", async () => {
  const source = `@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }
export @must_use /* attached trivia */ fn dead(value: f32) -> f32 { return value; }`;
  const vite = artifact(await transformWgsl(source, "/missing/dead-vite.wgsl"));
  const webpackArtifact = artifact((await webpack(source, "/missing/dead-webpack.wgsl")).code);

  for (const emitted of [vite, webpackArtifact]) {
    expect(emitted.functionExports).toEqual([]);
    expect(emitted.wgsl).not.toContain("@must_use");
    expect(emitted.wgsl).not.toContain("fn dead");
  }
});

test("direct-export leaf entry points allow comment trivia after fn", async () => {
  const source = "@fragment export fn /* declaration trivia */ fs_main() -> @location(0) vec4f { return vec4f(1.0); }";
  const vite = artifact(await transformWgsl(source, "/missing/entry-vite.wgsl"));
  const webpackArtifact = artifact((await webpack(source, "/missing/entry-webpack.wgsl")).code);

  for (const emitted of [vite, webpackArtifact]) {
    expect(emitted.functionExports).toEqual([
      { name: "fs_main", resolvedName: "fs_main", parameterNames: [] },
    ]);
    expect(emitted.wgsl).toMatch(/fn\s+\/\* declaration trivia \*\/\s+fs_main\s*\(/u);
  }
});

test.each([
  ["block comment", "export /* declaration gap */ fn surfaceValue(value: f32) -> f32 { return value; }"],
  ["line comment", "export // declaration gap\nfn surfaceValue(value: f32) -> f32 { return value; }"],
] as const)("direct-export leaf artifacts accept $0 trivia between export and fn", async (_label, source) => {
  const vite = artifact(await transformWgsl(source, "/missing/comment-vite.wgsl"));
  const webpackArtifact = artifact((await webpack(source, "/missing/comment-webpack.wgsl")).code);

  for (const emitted of [vite, webpackArtifact]) {
    expect(emitted.functionExports).toEqual([
      {
        name: "surfaceValue",
        resolvedName: expect.any(String),
        parameterNames: ["value"],
      },
    ]);
    expect(emitted.wgsl).not.toMatch(/\bexport\b/u);
    expect(emitted.wgsl).toMatch(functionDeclaration(emitted.functionExports[0]!.resolvedName));
  }
});

test("minified import-graph artifacts expose authored metadata for final declarations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-function-exports-"));
  const entry = join(dir, "main.wgsl");
  const helper = join(dir, "surface.wgsl");
  const source = `import { surfaceValue as shadeSurface } from "./surface.wgsl";
@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(shadeSurface(1.0), 0.0, 0.0, 1.0);
}`;
  await writeFile(entry, source);
  await writeFile(helper, "export fn surfaceValue(authoredValue: f32) -> f32 { return authoredValue * 2.0; }");

  const vite = artifact(await transformWgsl(await readFile(entry, "utf8"), entry, { minify: true }));
  const webpackArtifact = artifact((await webpack(source, entry, { minify: true })).code);

  for (const emitted of [vite, webpackArtifact]) {
    expect(emitted.functionExports).toEqual([
      {
        name: "surfaceValue",
        resolvedName: expect.any(String),
        parameterNames: ["authoredValue"],
      },
    ]);
    expect(emitted.wgsl).not.toContain("surfaceValue");
    expect(emitted.wgsl).toMatch(functionDeclaration(emitted.functionExports[0]!.resolvedName));
  }
});

test.each(importGraphLoaders)("%s import graphs use the transformed entry source instead of stale disk contents", async (_label, load) => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-entry-source-"));
  const entry = join(dir, "main.wgsl");
  const helper = join(dir, "helper.wgsl");
  await writeFile(entry, `import { helperValue } from "./helper.wgsl";
export fn diskValue(value: f32) -> f32 { return helperValue(value); }`);
  await writeFile(helper, "export fn helperValue(value: f32) -> f32 { return value; }");

  const transformedSource = `import { helperValue } from "./helper.wgsl";
export fn memoryValue(value: f32) -> f32 { return helperValue(value); }`;
  const emitted = await load(transformedSource, entry);

  expect(emitted.functionExports.map((item) => item.name)).toEqual([
    "memoryValue",
    "helperValue",
  ]);
});

test("import graphs resolve a virtual transformed entry with filesystem dependencies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-virtual-entry-source-"));
  const entry = join(dir, "missing-entry.wgsl");
  await writeFile(
    join(dir, "helper.wgsl"),
    "export fn helperValue(value: f32) -> f32 { return value; }",
  );
  const transformedSource = `import { helperValue } from "./helper.wgsl";
export fn memoryValue(value: f32) -> f32 { return helperValue(value); }`;

  for (const [, load] of importGraphLoaders) {
    const emitted = await load(transformedSource, entry);
    expect(emitted.functionExports.map((item) => item.name)).toEqual([
      "memoryValue",
      "helperValue",
    ]);
  }
});

function artifact(codeOrResult: string | { readonly code: string }): EmittedShaderSource {
  const code = typeof codeOrResult === "string" ? codeOrResult : codeOrResult.code;
  return Function(code.replace(/^export default /u, "return ").replace(/;$/u, ";"))() as EmittedShaderSource;
}

function webpack(
  source: string,
  resourcePath: string,
  options: { readonly minify?: boolean } = {},
): Promise<{ readonly code: string; readonly synchronous: boolean }> {
  return new Promise((resolve, reject) => {
    const returned = wgslWebpackLoader.call({
      resourcePath,
      getOptions: () => options,
      async: () => (error, code) => {
        if (error) reject(error);
        else resolve({ code: code ?? "", synchronous: false });
      },
    }, source);
    if (typeof returned === "string") resolve({ code: returned, synchronous: true });
  });
}

function functionDeclaration(name: string): RegExp {
  return new RegExp(`\\bfn\\s+${escapeRegExp(name)}\\s*\\(`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
