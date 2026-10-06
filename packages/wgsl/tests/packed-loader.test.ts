import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { decodePackedMetadata } from "../src/packed/decode.ts";
import { prepareShader } from "../src/prepare.ts";
import { selectPackedReflection } from "../src/loader-shared/packed-selection.ts";
import { shaderSourceModule } from "../src/loader-shared/emit.ts";
import { transformWgsl } from "../src/loader-vite/index.ts";
import wgslWebpackLoader from "../src/loader-webpack/index.ts";
import * as packedQueries from "../src/loader-shared/packed-query.ts";
import { evaluateShaderModule } from "./helpers/evaluate-shader-module.ts";
import type { ShaderReflection } from "../src/types.ts";

const execFileAsync = promisify(execFile);

test("small shader reflection stays literal without decoder or metadata modules", () => {
  const prepared = prepareShader("@compute @workgroup_size(1) fn main() {}", "/small.wgsl");

  expect(selectPackedReflection(prepared.reflection)).toBeNull();
});

test("the measured 16 KiB floor leaves the former 8 KiB candidate literal", () => {
  const reflection = prepareShader(layoutShader(8, 1), "/threshold.wgsl").reflection;
  const bytes = Buffer.byteLength(JSON.stringify(reflection), "utf8");

  expect(bytes).toBeGreaterThanOrEqual(8192);
  expect(bytes).toBeLessThan(16_384);
  expect(selectPackedReflection(reflection)).toBeNull();
});

test("large repeated layout metadata selects deterministic independently reachable blocks", () => {
  const prepared = prepareShader(layoutShader(8), "/shared.wgsl");
  const forward = selectPackedReflection(prepared.reflection);
  const repeated = selectPackedReflection(prepared.reflection);

  expect(forward).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify(prepared.reflection), "utf8")).toBeGreaterThanOrEqual(32_768);
  expect(forward!.shared.length).toBeGreaterThan(0);
  expect(forward).toEqual(repeated);
  expect(forward!.shared.every((block) => block.query.length <= 4096)).toBe(true);
  expect(decodePackedMetadata(forward!.table, forward!.shared.map((block) => block.table)))
    .toEqual(prepared.reflection);
});

test("over-cap extraction requests retain a useful inline packed plan", () => {
  const prepared = prepareShader(layoutShader(20), "/inline.wgsl");
  const plan = selectPackedReflection(prepared.reflection);

  expect(plan).not.toBeNull();
  expect(plan!.shared).toEqual([]);
  expect(decodePackedMetadata(plan!.table)).toEqual(prepared.reflection);
});

test("emitted packed modules reconstruct exact deeply frozen own-data ShaderSource artifacts", async () => {
  const source = layoutShader(8);
  const path = "/packed shared.wgsl";
  const code = shaderSourceModule(source, path);

  expect(code).toContain("decodePackedMetadata");
  expect(code).toContain("__vgpu_packed_v1=");
  expect(code.split(JSON.stringify(source))).toHaveLength(2);
  const imports = [...code.matchAll(/^import .+ from (".+");$/gmu)]
    .map((match) => JSON.parse(match[1]!) as string);
  expect(imports[0]).toMatch(/\/dist\/packed-metadata\.js$/u);
  expect(imports.slice(1).every((specifier) => specifier.includes("/src/metadata.wgsl?__vgpu_packed_v1=")))
    .toBe(true);
  expect(code).not.toMatch(/prepareShader|packed-selection|packed-query|reflectSource/u);

  const first = await evaluateShaderModule(code);
  const second = await evaluateShaderModule(code);
  expect(first).toEqual(prepareShader({ wgsl: source, functionExports: [] }, path));
  expect(Object.keys(first)).toEqual(["version", "wgsl", "reflection", "sourceChecksum", "producer", "functionExports"]);
  expect(first.reflection).not.toBe(second.reflection);
  expect(Object.getOwnPropertyDescriptor(first, "reflection")).toMatchObject({
    enumerable: true,
    writable: false,
    configurable: false,
  });
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.reflection)).toBe(true);
  expect(Object.isFrozen(first.reflection.bindings[0]?.layout)).toBe(true);
  expect(first.reflection.bindings[0]?.struct).toEqual(first.reflection.structs[0]);
  expect(first.reflection.bindings[0]?.struct).not.toBe(first.reflection.structs[0]);
  expect(first.reflection.bindings[0]?.layout).toEqual(first.reflection.hostShareableLayouts[0]);
  expect(first.reflection.bindings[0]?.layout).not.toBe(first.reflection.hostShareableLayouts[0]);
});

test("inline packed emission remains exact when no candidate query fits the cap", async () => {
  const source = layoutShader(20);
  const path = "/inline-packed.wgsl";
  const code = shaderSourceModule(source, path);

  expect(code).toContain("decodePackedMetadata");
  expect(code).not.toContain("__vgpu_packed_v1=");
  expect(await evaluateShaderModule(code)).toEqual(prepareShader({ wgsl: source, functionExports: [] }, path));
});

test("webpack loader chooses safe packed imports for webpack, Turbopack and unknown hosts", () => {
  const source = layoutShader(8);
  const loaderPath = "/installed @vgpu/wgsl/loader-webpack.js";
  const turbopackPath = resolve("fixtures/next-app/src/packed.wgsl");
  const webpackCode = wgslWebpackLoader.call({
    resourcePath: "/webpack-context.wgsl",
    _compiler: { webpack: {} },
    loaders: [{ path: loaderPath }],
    loaderIndex: 0,
    async: () => {
      throw new Error("sync packed leaf unexpectedly requested asynchronous mode");
    },
  }, source);
  const turbopackCode = wgslWebpackLoader.call({
    resourcePath: turbopackPath,
    _module: { __reserved: "TurbopackContext" },
  }, source);
  const unknownCode = wgslWebpackLoader.call({ resourcePath: "/unknown-context.wgsl" }, source);

  expect(webpackCode).toContain(`!!${loaderPath}!`);
  expect(webpackCode).toContain("metadata.wgsl?__vgpu_packed_v1=");
  expect(turbopackCode).toContain("decodePackedMetadata");
  expect(turbopackCode).not.toContain("metadata.wgsl?__vgpu_packed_v1=");
  const relativeDecoder = relative(dirname(turbopackPath), packedQueries.packedModuleAssets().decoder).replace(/\\/gu, "/");
  expect(turbopackCode).toContain(JSON.stringify(relativeDecoder.startsWith(".") ? relativeDecoder : `./${relativeDecoder}`));
  expect(turbopackCode).not.toContain(JSON.stringify(packedQueries.packedModuleAssets().decoder));
  expect(turbopackCode).not.toContain("!!");
  expect(unknownCode).toContain("decodePackedMetadata");
  expect(unknownCode).not.toContain("metadata.wgsl?__vgpu_packed_v1=");
});

test("Turbopack synthetic paths safely retain ordinary literal metadata", () => {
  const code = wgslWebpackLoader.call({
    resourcePath: "virtual:packed.wgsl",
    _module: { __reserved: "TurbopackContext" },
  }, layoutShader(8));

  expect(code).toMatch(/^const _vgpuFreeze=[^\n]*\nexport default \/\* @__PURE__ \*\/ _vgpuFreeze\(\{/u);
  expect(code).not.toMatch(/^\s*import\b/mu);
  expect(code).not.toContain("decodePackedMetadata");
  expect(code).not.toContain("metadata.wgsl?__vgpu_packed_v1=");
});

test("Turbopack prefixes relative decoder paths whose first segment is hidden", () => {
  const fixtureRoot = resolve(tmpdir(), "packed-hidden-path");
  const resourcePath = join(fixtureRoot, "shader.wgsl");
  const assets = packedQueries.packedModuleAssets();
  const assetSpy = vi.spyOn(packedQueries, "packedModuleAssets").mockReturnValue({
    ...assets,
    decoder: join(fixtureRoot, ".hidden", "packed-metadata.js"),
  });
  try {
    const code = wgslWebpackLoader.call({
      resourcePath,
      _module: { __reserved: "TurbopackContext" },
    }, layoutShader(8));

    expect(code).toContain(JSON.stringify("./.hidden/packed-metadata.js"));
    expect(code).not.toContain(' from ".hidden/packed-metadata.js";');
  } finally {
    assetSpy.mockRestore();
  }
});

test("plain fallback structurally emits hostile quoted __proto__ text", async () => {
  const source = `// hostile "__proto__": text\n@compute @workgroup_size(1) fn main() {}`;
  const code = shaderSourceModule(source, "/hostile.wgsl");

  expect(code).not.toContain('["__proto__"]: text');
  expect(await evaluateShaderModule(code)).toEqual(prepareShader({ wgsl: source, functionExports: [] }, "/hostile.wgsl"));
});

test("storage-only f16 stays plain while qualifying f16 uniforms preserve exact metadata", async () => {
  const storageSource = f16LayoutShader();
  const storagePath = "/plain-storage-f16.wgsl";
  const storageCode = shaderSourceModule(storageSource, storagePath);
  expect(storageCode).not.toContain("decodePackedMetadata");
  expect(await evaluateShaderModule(storageCode))
    .toEqual(prepareShader({ wgsl: storageSource, functionExports: [] }, storagePath));

  const source = qualifyingF16LayoutShader();
  const path = "/packed-f16.wgsl";
  const code = shaderSourceModule(source, path);
  const emitted = await evaluateShaderModule(code);
  expect(code).toContain("decodePackedMetadata");
  expect(emitted).toEqual(prepareShader({ wgsl: source, functionExports: [] }, path));
  expect(emitted.reflection.featuresRequired).toContain("f16");
  expect(emitted.reflection.entryPoints[0]?.workgroupSize).toEqual(["unresolved", 2, 1]);
});

test.each([
  ["unchanged", undefined],
  ["identifier minified", true],
  ["whitespace only", { identifiers: "none" }],
] as const)("packed loader output stays exact when WGSL is %s", async (_label, minify) => {
  const source = layoutShader(8);
  const viteResult = await transformWgsl(source, "/large-vite.wgsl", minify === undefined ? undefined : { minify });
  const webpackCode = wgslWebpackLoader.call({
    resourcePath: "/large-webpack.wgsl",
    getOptions: () => minify === undefined ? {} : { minify },
  }, source);

  expect(typeof webpackCode).toBe("string");
  for (const [code, path] of [[viteResult.code, "/large-vite.wgsl"], [webpackCode!, "/large-webpack.wgsl"]] as const) {
    expect(code).toContain("decodePackedMetadata");
    const emitted = await evaluateShaderModule(code);
    expect(emitted).toEqual(prepareShader({ wgsl: emitted.wgsl, functionExports: [] }, path));
  }
});

test("packed direct exports keep webpack asynchronous and use authoritative in-memory source", async () => {
  const diskPath = "/missing/packed-direct-export.wgsl";
  const source = `${layoutShader(8).replace("let value = params0.m0;", "let value = params0.m0; let exposed = authored(1.0);")}\nexport fn authored(value: f32) -> f32 { return value; }`;
  const result = await webpackAsync(source, diskPath);
  const emitted = await evaluateShaderModule(result);

  expect(result).toContain("decodePackedMetadata");
  expect(emitted.functionExports).toEqual([
    { name: "authored", resolvedName: expect.any(String), parameterNames: ["value"] },
  ]);
  expect(emitted).toEqual(prepareShader({ wgsl: emitted.wgsl, functionExports: emitted.functionExports }, diskPath));
});

test("packed import graphs use in-memory entries and retain dependency reporting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-packed-graph-"));
  const entry = join(dir, "entry.wgsl");
  const helper = join(dir, "layout.wgsl");
  await writeFile(helper, `export struct Params {\n${layoutMembers(8)}\n}`);
  await writeFile(entry, "fn staleDiskEntry() {}");
  const source = `import { Params } from "./layout.wgsl";\n${layoutBindings(4)}
@compute @workgroup_size(1) fn memoryEntry() { let value = params0.m0; }`;
  const viteDependencies: string[] = [];
  const webpackDependencies: string[] = [];
  const vite = await transformWgsl({ source, id: entry, onDependency: (path) => viteDependencies.push(path) });
  const webpack = await webpackAsync(source, entry, webpackDependencies);

  for (const code of [vite.code, webpack]) {
    expect(code).toContain("decodePackedMetadata");
    const emitted = await evaluateShaderModule(code);
    expect(emitted.wgsl).toContain("memoryEntry");
    expect(emitted.wgsl).not.toContain("staleDiskEntry");
  }
  expect(viteDependencies).toContain(helper);
  expect(webpackDependencies).toContain(helper);
});

test("packed-shaped failing graphs report discovered dependencies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-packed-failure-"));
  const entry = join(dir, "entry.wgsl");
  const helper = join(dir, "layout.wgsl");
  await writeFile(helper, `export struct Different {\n${layoutMembers(8)}\n}`);
  const source = `import { Params } from "./layout.wgsl";\n${layoutBindings(4)}
@compute @workgroup_size(1) fn main() { let value = params0.m0; }`;
  const viteDependencies: string[] = [];
  const webpackDependencies: string[] = [];

  await expect(transformWgsl({ source, id: entry, onDependency: (path) => viteDependencies.push(path) }))
    .rejects.toMatchObject({ code: "VGPU-WGSL-SYM-NOEXPORT" });
  await expect(webpackAsync(source, entry, webpackDependencies))
    .rejects.toMatchObject({ code: "VGPU-WGSL-SYM-NOEXPORT" });
  expect(viteDependencies).toContain(helper);
  expect(webpackDependencies).toContain(helper);
});

test("candidate-visit exhaustion falls back to a bounded inline packed plan", () => {
  const repeated = {
    name: "x".repeat(256),
    nested: Array.from({ length: 7 }, () => []),
  };
  const reflection = {
    bindings: [
      { kind: "buffer", addressSpace: "uniform", layout: { name: "first", data: "a".repeat(2304) } },
      { kind: "buffer", addressSpace: "uniform", layout: { name: "second", data: "b".repeat(2304) } },
    ],
    aliases: Array.from({ length: 8192 }, () => repeated),
  } as unknown as ShaderReflection;
  const plan = selectPackedReflection(reflection);

  expect(plan).not.toBeNull();
  expect(plan!.shared).toEqual([]);
  expect(decodePackedMetadata(plan!.table)).toEqual(reflection);
});

test("packed identities are independent of call order and process state", async () => {
  const fixtures = [
    { path: "/order-a.wgsl", source: layoutShader(8) },
    { path: "/order-b.wgsl", source: qualifyingF16LayoutShader() },
  ];
  const local = new Map(fixtures.map((fixture) => [
    fixture.path,
    selectPackedReflection(prepareShader(fixture.source, fixture.path).reflection),
  ]));
  const forward = await selectInChild(fixtures);
  const reverse = await selectInChild([...fixtures].reverse());

  expect(forward.get(fixtures[0]!.path)).toEqual(local.get(fixtures[0]!.path));
  expect(forward.get(fixtures[1]!.path)).toEqual(local.get(fixtures[1]!.path));
  expect(reverse).toEqual(forward);
});

function layoutMembers(memberCount: number): string {
  return Array.from({ length: memberCount }, (_, index) => {
    const type = index % 3 === 0 ? "mat4x4f" : index % 3 === 1 ? "array<vec4f, 4>" : "vec4f";
    return `m${index}: ${type},`;
  }).join("\n");
}

function layoutBindings(bindingCount: number): string {
  return Array.from({ length: bindingCount }, (_, index) =>
    `@group(0) @binding(${index}) var<uniform> params${index}: Params;`
  ).join("\n");
}

function layoutShader(memberCount: number, bindingCount = 4): string {
  const members = layoutMembers(memberCount);
  const bindings = layoutBindings(bindingCount);
  return `struct Params {\n${members}\n}
${bindings}
@compute @workgroup_size(1) fn main() { let value = params0.m0; }`;
}

function f16LayoutShader(): string {
  const members = Array.from({ length: 10 }, (_, index) => `m${index}: array<vec4<f16>, 4>,`).join("\n");
  return `enable f16;
alias Half = f16;
struct Params {\n${members}\n}
@group(0) @binding(0) var<storage, read> params0: Params;
@group(0) @binding(1) var<storage, read> params1: Params;
@group(0) @binding(2) var<storage, read> params2: Params;
@group(0) @binding(3) var<storage, read> params3: Params;
@id(7) override WIDTH: u32;
@compute @workgroup_size(WIDTH, 2, 1) fn main() { let value = params0.m0[0]; }`;
}

function qualifyingF16LayoutShader(): string {
  const first = Array.from({ length: 10 }, (_, index) => `a${index}: vec4<f16>,`).join("\n");
  const second = Array.from({ length: 11 }, (_, index) => `b${index}: vec4<f16>,`).join("\n");
  return `enable f16;
struct HalfFirst {\n${first}\n}
struct HalfSecond {\n${second}\n}
@group(0) @binding(0) var<uniform> first: HalfFirst;
@group(0) @binding(1) var<uniform> second: HalfSecond;
@id(7) override WIDTH: u32;
@compute @workgroup_size(WIDTH, 2, 1) fn main() { _ = first.a0; _ = second.b0; }`;
}

function webpackAsync(source: string, resourcePath: string, dependencies: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const returned = wgslWebpackLoader.call({
      resourcePath,
      addDependency: (path) => dependencies.push(path),
      async: () => (error, code) => error ? reject(error) : resolve(code ?? ""),
    }, source);
    if (typeof returned === "string") reject(new Error("expected asynchronous webpack loader branch"));
  });
}

async function selectInChild(
  fixtures: readonly { readonly path: string; readonly source: string }[],
): Promise<Map<string, unknown>> {
  const prepareUrl = pathToFileURL(resolve("packages/wgsl/dist/prepare.js")).href;
  const selectionUrl = pathToFileURL(resolve("packages/wgsl/dist/loader-shared/packed-selection.js")).href;
  const script = `
    import { prepareShader } from ${JSON.stringify(prepareUrl)};
    import { selectPackedReflection } from ${JSON.stringify(selectionUrl)};
    const fixtures = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
    console.log(JSON.stringify(fixtures.map((fixture) => [fixture.path, selectPackedReflection(prepareShader(fixture.source, fixture.path).reflection)])));
  `;
  const encoded = Buffer.from(JSON.stringify(fixtures), "utf8").toString("base64url");
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script, encoded]);
  return new Map(JSON.parse(stdout) as [string, unknown][]);
}
