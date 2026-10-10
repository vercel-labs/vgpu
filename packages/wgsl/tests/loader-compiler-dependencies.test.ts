import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test, vi } from "vitest";
import { encodePackedMetadata } from "../src/packed/encode.ts";
import { encodePackedQuery, packedModuleAssets } from "../src/loader-shared/packed-query.ts";
import { transformWgsl } from "../src/loader-vite/index.ts";
import wgslWebpackLoader from "../src/loader-webpack/index.ts";

const LEAF = "@compute @workgroup_size(1) fn main() {}";
const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

test("webpack registers the complete compiler inventory as build dependencies before returning", () => {
  const buildDependencies: string[] = [];
  const shaderDependencies: string[] = [];
  const code = wgslWebpackLoader.call({
    resourcePath: "/shader.wgsl",
    _compiler: {},
    addBuildDependency: (file: string) => buildDependencies.push(file),
    addDependency: (file: string) => shaderDependencies.push(file),
  }, LEAF);

  expect(code).toContain("export default");
  expect(buildDependencies).toEqual(expect.arrayContaining([
    expect.stringMatching(/packages\/wgsl\/package\.json$/u),
    expect.stringMatching(/packages\/wgsl\/src\/metadata\.wgsl$/u),
    expect.stringMatching(/packages\/wgsl\/src\/loader-webpack\/index\.ts$/u),
    expect.stringMatching(/packages\/wgsl\/src\/next\/index\.ts$/u),
  ]));
  expect(new Set(buildDependencies).size).toBe(buildDependencies.length);
  expect(shaderDependencies).toEqual([]);
});

test("Turbopack uses file dependencies even when a nominal build hook exists", () => {
  const addBuildDependency = vi.fn();
  const fileDependencies: string[] = [];
  wgslWebpackLoader.call({
    resourcePath: "/shader.wgsl",
    _module: { __reserved: Symbol("TurbopackContext") },
    addBuildDependency,
    addDependency: (file: string) => fileDependencies.push(file),
  }, LEAF);

  expect(addBuildDependency).not.toHaveBeenCalled();
  expect(fileDependencies).toEqual(expect.arrayContaining([
    expect.stringMatching(/packages\/wgsl\/package\.json$/u),
    expect.stringMatching(/packages\/wgsl\/src\/metadata\.wgsl$/u),
  ]));
});

test("Turbopack orders compiler files before shader dependencies in one stream", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-loader-turbopack-order-")));
  scratch.push(root);
  const entry = join(root, "main.wgsl");
  const dependency = join(root, "dependency.wgsl");
  const source = "import { dependency } from './dependency.wgsl'; fn main() { dependency(); }";
  await writeFile(entry, source);
  await writeFile(dependency, "export fn dependency() {}\n");
  const dependencies: string[] = [];

  await runAsyncLoader({
    resourcePath: entry,
    _module: { __reserved: "TurbopackContext" },
    addDependency: (file: string) => dependencies.push(file),
  }, source);
  const shaderIndex = dependencies.indexOf(dependency);
  expect(shaderIndex).toBeGreaterThan(2);
  expect(dependencies.slice(0, shaderIndex)).toEqual(expect.arrayContaining([
    expect.stringMatching(/packages\/wgsl\/package\.json$/u),
    expect.stringMatching(/packages\/wgsl\/src\/metadata\.wgsl$/u),
  ]));
  expect(dependencies.slice(shaderIndex)).toEqual([dependency]);
});

test("file-hook-only contexts register compiler dependencies without webpack markers", () => {
  const dependencies: string[] = [];
  wgslWebpackLoader.call({
    resourcePath: "/shader.wgsl",
    addDependency: (file: string) => dependencies.push(file),
  }, LEAF);

  expect(dependencies).toEqual(expect.arrayContaining([
    expect.stringMatching(/packages\/wgsl\/package\.json$/u),
    expect.stringMatching(/packages\/wgsl\/src\/metadata\.wgsl$/u),
  ]));
});

test("compiler registration precedes valid metadata returns and malformed metadata errors", () => {
  const table = encodePackedMetadata({ value: [1, 2, 3] });
  if (!table) throw new Error("metadata fixture did not encode");
  const query = encodePackedQuery(table);
  if (!query) throw new Error("metadata fixture query exceeded its bound");
  const buildDependencies: string[] = [];
  const context = {
    resourcePath: packedModuleAssets().anchor,
    resourceQuery: query,
    _compiler: {},
    addBuildDependency: (file: string) => buildDependencies.push(file),
  };

  expect(wgslWebpackLoader.call(context, "not shader source")).toBe(`export default ${JSON.stringify(table)};`);
  expect(buildDependencies.length).toBeGreaterThan(3);

  buildDependencies.length = 0;
  expect(() => wgslWebpackLoader.call({ ...context, resourceQuery: "?__vgpu_packed_v1=bad!" }, "ignored"))
    .toThrow(expect.objectContaining({ code: "VGPU-WGSL-PACKED-METADATA-INVALID" }));
  expect(buildDependencies.length).toBeGreaterThan(3);
});

test("direct exports and imported graphs preserve their async loader branches", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-loader-async-")));
  scratch.push(root);
  const dependency = join(root, "dependency.wgsl");
  await writeFile(dependency, "export fn dependency() {}\n");

  for (const [name, source, expectedShaderDependencies] of [
    ["direct.wgsl", "export fn exposed() {}", []],
    ["graph.wgsl", "import { dependency } from './dependency.wgsl'; fn main() { dependency(); }", [dependency]],
  ] as const) {
    const compilerDependencies: string[] = [];
    const shaderDependencies: string[] = [];
    const code = await runAsyncLoader({
      resourcePath: join(root, name),
      _compiler: {},
      addBuildDependency: (file: string) => compilerDependencies.push(file),
      addDependency: (file: string) => shaderDependencies.push(file),
    }, source);

    expect(code).toContain("export default");
    expect(compilerDependencies.length).toBeGreaterThan(3);
    expect(shaderDependencies).toEqual(expectedShaderDependencies);
  }
});

test("shader dependencies stay separate and ordered after compiler dependencies", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-loader-deps-")));
  scratch.push(root);
  const entry = join(root, "main.wgsl");
  const dependency = join(root, "dependency.wgsl");
  const source = "import { expected } from './dependency.wgsl'; fn main() { expected(); }";
  await writeFile(entry, source);
  await writeFile(dependency, "export fn different() {}\n");
  const compilerDependencies: string[] = [];
  const shaderDependencies: string[] = [];

  const failure = runAsyncLoader({
    resourcePath: entry,
    _compiler: {},
    addBuildDependency: (file: string) => compilerDependencies.push(file),
    addDependency: (file: string) => shaderDependencies.push(file),
  }, source);
  await expect(failure).rejects.toMatchObject({ code: "VGPU-WGSL-SYM-NOEXPORT" });
  expect(compilerDependencies.length).toBeGreaterThan(3);
  expect(shaderDependencies).toEqual([dependency]);
});

test("missing shader candidates retain their order apart from compiler files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-loader-missing-")));
  scratch.push(root);
  const entry = join(root, "main.wgsl");
  const source = "import { expected } from './missing'; fn main() { expected(); }";
  await writeFile(entry, source);
  const compilerDependencies: string[] = [];
  const shaderDependencies: string[] = [];

  await expect(runAsyncLoader({
    resourcePath: entry,
    _compiler: {},
    addBuildDependency: (file: string) => compilerDependencies.push(file),
    addDependency: (file: string) => shaderDependencies.push(file),
  }, source)).rejects.toMatchObject({ code: "VGPU-WGSL-RES-NOTFOUND" });
  expect(compilerDependencies.length).toBeGreaterThan(3);
  expect(shaderDependencies).toEqual([
    join(root, "missing.wgsl"),
    join(root, "missing", "index.wgsl"),
  ]);
});

test("minimal contexts remain synchronous and registration failures use the branch channel", async () => {
  expect(wgslWebpackLoader.call({ resourcePath: "/minimal.wgsl" }, LEAF)).toContain("export default");

  const cause = new Error("dependency hook failed");
  const leafAsync = vi.fn(() => vi.fn());
  expect(() => wgslWebpackLoader.call({
    resourcePath: "/failed.wgsl",
    _compiler: {},
    addBuildDependency: () => { throw cause; },
    async: leafAsync,
  }, LEAF)).toThrow(expect.objectContaining({
    code: "VGPU-WGSL-CACHE-IDENTITY",
    where: "wgslWebpackLoader",
    cause,
    metadata: { path: expect.any(String) },
  }));
  expect(leafAsync).not.toHaveBeenCalled();

  const table = encodePackedMetadata({ value: true });
  if (!table) throw new Error("metadata fixture did not encode");
  const query = encodePackedQuery(table);
  if (!query) throw new Error("metadata fixture query exceeded its bound");
  const metadataAsync = vi.fn(() => vi.fn());
  expect(() => wgslWebpackLoader.call({
    resourcePath: packedModuleAssets().anchor,
    resourceQuery: query,
    addDependency: () => { throw cause; },
    async: metadataAsync,
  }, "not shader source")).toThrow(expect.objectContaining({ code: "VGPU-WGSL-CACHE-IDENTITY" }));
  expect(metadataAsync).not.toHaveBeenCalled();

  const done = vi.fn();
  const graphAsync = vi.fn(() => done);
  expect(wgslWebpackLoader.call({
    resourcePath: "/graph.wgsl",
    addDependency: () => { throw cause; },
    async: graphAsync,
  }, "import { missing } from './missing.wgsl'; fn main() { missing(); }")).toBeUndefined();
  expect(graphAsync).toHaveBeenCalledTimes(1);
  expect(done).toHaveBeenCalledTimes(1);
  expect(done).toHaveBeenCalledWith(expect.objectContaining({
    code: "VGPU-WGSL-CACHE-IDENTITY",
    where: "wgslWebpackLoader",
    cause,
  }));
});

test("Vite dependency callbacks still receive shader files only", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-vite-deps-")));
  scratch.push(root);
  const entry = join(root, "main.wgsl");
  const dependency = join(root, "dependency.wgsl");
  const source = "import { expected } from './dependency.wgsl'; fn main() { expected(); }";
  await writeFile(entry, source);
  await writeFile(dependency, "export fn expected() {}\n");
  const dependencies: string[] = [];

  await transformWgsl({ source, id: entry, onDependency: (file) => dependencies.push(file) });
  expect(dependencies).toEqual([dependency]);
});

test("source-only repository invocation discovers the copied source tree without dist", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-loader-source-only-")));
  scratch.push(root);
  await cp(resolve("packages/wgsl/src"), join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), await readFile(resolve("packages/wgsl/package.json")));
  const module = await import(/* @vite-ignore */ `${pathToFileURL(join(root, "src/loader-webpack/index.ts")).href}?copy=${Date.now()}`) as {
    readonly default: typeof wgslWebpackLoader;
  };
  const dependencies: string[] = [];

  expect(module.default.call({
    resourcePath: join(root, "shader.wgsl"),
    _compiler: {},
    addBuildDependency: (file: string) => dependencies.push(file),
  }, LEAF)).toContain("export default");
  expect(dependencies).toEqual(expect.arrayContaining([
    join(root, "package.json"),
    join(root, "src/metadata.wgsl"),
    join(root, "src/loader-webpack/index.ts"),
  ]));
  expect(dependencies.some((file) => file.includes("/dist/"))).toBe(false);
});

function runAsyncLoader(
  context: Record<string, unknown>,
  source: string,
): Promise<string> {
  return new Promise((resolveCode, reject) => {
    wgslWebpackLoader.call({
      ...context,
      async: () => (error: Error | null, code?: string) => error ? reject(error) : resolveCode(code ?? ""),
    }, source);
  });
}
