import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import webpack, { type Configuration, type Stats } from "webpack";
import { describe, expect, it } from "vitest";
import type { ShaderSource } from "@vgpu/wgsl";

const require = createRequire(import.meta.url);

describe("wgslWebpackLoader (real webpack 5)", () => {
  it("bundles a .wgsl file with imports through wgslWebpackLoader", async () => {
    const { entryJs, outDir } = await writeFixture();
    const bundleName = "bundle.cjs";

    await runWebpack({
      mode: "development",
      target: "node",
      entry: entryJs,
      output: { path: outDir, filename: bundleName, libraryTarget: "commonjs2" },
      module: { rules: [{ test: /\.wgsl$/, loader: resolveWebpackLoader() }] },
      optimization: { minimize: false },
    });

    const bundle = await readFile(join(outDir, bundleName), "utf8");
    expectBundleContainsResolvedWgsl(bundle);
    expectPreparedShaderSource(requireShaderSource(join(outDir, bundleName)));
    expect(bundle).not.toContain("prepareShader");
    expect(bundle).not.toContain("reflectSource");
  });

  it("resolves the loader via bare string 'package-name/loader-path'", async () => {
    const { dir, entryJs, outDir } = await writeFixture();
    await installWorkspacePackage(dir);
    const bundleName = "bundle.cjs";

    await runWebpack({
      mode: "development",
      target: "node",
      context: dir,
      entry: entryJs,
      output: { path: outDir, filename: bundleName, libraryTarget: "commonjs2" },
      module: { rules: [{ test: /\.wgsl$/, loader: "@vgpu/wgsl/loader-webpack" }] },
      optimization: { minimize: false },
    });

    expectBundleContainsResolvedWgsl(await readFile(join(outDir, bundleName), "utf8"));
  });

  it("honors the minify loader option in a real webpack build", async () => {
    const { entryJs, outDir } = await writeFixture();
    const bundleName = "bundle.cjs";

    await runWebpack({
      mode: "development",
      target: "node",
      entry: entryJs,
      output: { path: outDir, filename: bundleName, libraryTarget: "commonjs2" },
      module: { rules: [{ test: /\.wgsl$/, loader: resolveWebpackLoader(), options: { minify: true } }] },
      optimization: { minimize: false },
    });

    const wgsl = requireShaderSource(join(outDir, bundleName)).wgsl;
    expect(wgsl).not.toContain("helper_color");
    expect(wgsl).toContain("return b();");
    expect(wgsl).toContain("fn a()-> vec4f");
    expect(wgsl).not.toContain("helper comment");
    expect(wgsl).not.toContain("entry comment");
  });

  it("triggers re-compile when a transitively imported .wgsl changes (addDependency wiring)", async () => {
    const { entryJs, outDir, helperWgsl } = await writeFixture();
    const stats = await runWebpack({
      mode: "development",
      target: "node",
      entry: entryJs,
      output: { path: outDir, filename: "bundle.cjs", libraryTarget: "commonjs2" },
      module: { rules: [{ test: /\.wgsl$/, loader: resolveWebpackLoader() }] },
      optimization: { minimize: false },
    });

    expect(stats.compilation.fileDependencies.has(await realpath(helperWgsl))).toBe(true);
  });

  it("emits fresh bundled WGSL when a transitive import changes between builds", async () => {
    const { entryJs, outDir, helperWgsl } = await writeFixture();
    const config: Configuration = {
      mode: "development",
      target: "node",
      entry: entryJs,
      output: { path: outDir, filename: "bundle.cjs", libraryTarget: "commonjs2" },
      module: { rules: [{ test: /\.wgsl$/, loader: resolveWebpackLoader() }] },
      optimization: { minimize: false },
    };

    await runWebpack(config);
    const first = await readFile(join(outDir, "bundle.cjs"), "utf8");
    await writeFile(helperWgsl, "export fn helper_color() -> vec4f { return vec4f(0.9, 0.8, 0.7, 1.0); }");
    await runWebpack(config);
    const second = await readFile(join(outDir, "bundle.cjs"), "utf8");

    expect(first).toContain("0.1, 0.2, 0.3, 1.0");
    expect(second).not.toBe(first);
    expect(second).toContain("0.9, 0.8, 0.7, 1.0");
  });

  it("bundles packed reflection through the packaged decoder and metadata anchor", async () => {
    const { entryJs, outDir } = await writePackedFixture();
    const bundleName = "bundle.cjs";
    const stats = await runWebpack({
      mode: "development",
      target: "node",
      entry: entryJs,
      output: { path: outDir, filename: bundleName, libraryTarget: "commonjs2" },
      module: { rules: [{ test: /\.wgsl$/, loader: resolveWebpackLoader() }] },
      optimization: { minimize: false },
    });
    const bundlePath = join(outDir, bundleName);
    const bundle = await readFile(bundlePath, "utf8");
    const shader = requireShaderSource(bundlePath);
    const modules = JSON.stringify(stats.toJson({ all: false, modules: true }).modules);

    expect(shader.reflection.bindings).toHaveLength(4);
    expect(shader.reflection.hostShareableLayouts[0]?.members).toHaveLength(8);
    expect(bundle).not.toContain("prepareShader");
    expect(bundle).not.toContain("reflectSource");
    expect(modules).toContain("metadata.wgsl?__vgpu_packed_v1=");
    expect(modules).toContain(resolveWebpackLoader());
    expectPreparedShaderSource(shader);
  });

  it("loads packed anchors when the author rule is scoped to application source", async () => {
    const { dir, entryJs, outDir } = await writePackedFixture();
    const bundleName = "bundle.cjs";
    const stats = await runWebpack({
      mode: "development",
      target: "node",
      entry: entryJs,
      output: { path: outDir, filename: bundleName, libraryTarget: "commonjs2" },
      module: { rules: [{ test: /\.wgsl$/, include: await realpath(dir), loader: resolveWebpackLoader() }] },
      optimization: { minimize: false },
    });

    const modules = JSON.stringify(stats.toJson({ all: false, modules: true }).modules);
    const shader = requireShaderSource(join(outDir, bundleName));
    expect(shader.reflection.hostShareableLayouts[0]?.members).toHaveLength(8);
    expect(modules).toContain(`${resolveWebpackLoader()}!${resolve("packages/wgsl/src/metadata.wgsl")}`);
    expect(modules).toContain("metadata.wgsl?__vgpu_packed_v1=");
  });
});

async function writeFixture(): Promise<{ dir: string; entryJs: string; outDir: string; helperWgsl: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-webpack-"));
  const outDir = join(dir, "dist");
  const helperWgsl = join(dir, "helper.wgsl");
  await mkdir(outDir, { recursive: true });
  await writeFile(helperWgsl, "// helper comment\nexport fn helper_color() -> vec4f { return vec4f(0.1, 0.2, 0.3, 1.0); }");
  await writeFile(join(dir, "entry.wgsl"), `import { helper_color } from "./helper.wgsl";
// entry comment
fn main_color() -> vec4f { return helper_color(); }`);
  await writeFile(join(dir, "entry.js"), `import shader from "./entry.wgsl";
export default shader;`);
  return { dir, entryJs: join(dir, "entry.js"), outDir, helperWgsl };
}

async function writePackedFixture(): Promise<{ dir: string; entryJs: string; outDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-webpack-packed-"));
  const outDir = join(dir, "dist");
  const members = Array.from({ length: 8 }, (_, index) => {
    const type = index % 3 === 0 ? "mat4x4f" : index % 3 === 1 ? "array<vec4f, 4>" : "vec4f";
    return `m${index}: ${type},`;
  }).join("\n");
  await mkdir(outDir, { recursive: true });
  const bindings = Array.from({ length: 4 }, (_, index) =>
    `@group(0) @binding(${index}) var<uniform> params${index}: Params;`
  ).join("\n");
  await writeFile(join(dir, "entry.wgsl"), `struct Params {\n${members}\n}
${bindings}
@compute @workgroup_size(1) fn main() { let value = params0.m0; }`);
  await writeFile(join(dir, "entry.js"), `import shader from "./entry.wgsl";\nexport default shader;`);
  return { dir, entryJs: join(dir, "entry.js"), outDir };
}

async function installWorkspacePackage(dir: string): Promise<void> {
  const scopeDir = join(dir, "node_modules", "@vgpu");
  await mkdir(scopeDir, { recursive: true });
  await symlink(resolve("packages/wgsl"), join(scopeDir, "wgsl"), "dir");
}

function resolveWebpackLoader(): string {
  return require.resolve("@vgpu/wgsl/loader-webpack");
}

function requireShaderSource(path: string): ShaderSource {
  const loaded = require(path) as { readonly default?: unknown };
  const value = loaded.default ?? loaded;
  if (!value || typeof value !== "object" || !("wgsl" in value) || typeof value.wgsl !== "string") {
    throw new Error("webpack bundle did not export a ShaderSource");
  }
  return value as ShaderSource;
}

function expectPreparedShaderSource(shader: ShaderSource): void {
  expect(shader).toMatchObject({
    version: 2,
    producer: "@vgpu/wgsl/prepare-v2",
    reflection: expect.objectContaining({ entryPoints: expect.any(Array) }),
    sourceChecksum: expect.stringMatching(/^fnv1a64-utf16le-v1:[0-9a-f]{16}$/u),
    functionExports: expect.any(Array),
  });
}

function expectBundleContainsResolvedWgsl(bundle: string): void {
  expect(bundle).toContain("helper_color");
  expect(bundle).toContain("main_color");
  expect(bundle).toContain("return _vgsl_");
}

function runWebpack(config: Configuration): Promise<Stats> {
  return new Promise((resolve, reject) => {
    webpack(config, (error, stats) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stats) {
        reject(new Error("webpack completed without stats"));
        return;
      }
      if (stats.hasErrors()) {
        reject(new Error(stats.toString({ all: false, errors: true, errorDetails: true })));
        return;
      }
      resolve(stats);
    });
  });
}
