import { execFile as execFileCallback } from "node:child_process";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import webpack, { type Configuration, type Stats } from "webpack";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prepareShader } from "../src/prepare.ts";
import type { ShaderSource } from "../src/types.ts";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const workspaceWgsl = resolve("packages/wgsl");
const workspaceWgslStd = resolve("packages/wgsl-std");
let fixture: Awaited<ReturnType<typeof createPackedPackages>>;

beforeAll(async () => {
  fixture = await createPackedPackages();
}, 60_000);

afterAll(async () => {
  await fixture?.dispose();
});

describe("actual packed @vgpu/wgsl distribution", () => {
  test("tar members contain the private runtime, anchor and public declarations", async () => {
    const members = await tarMembers(fixture.wgslTarball);
    expect(members).toContain("package/src/metadata.wgsl");
    expect(members).toContain("package/dist/packed-metadata.js");
    expect(members).toContain("package/dist/packed-metadata.d.ts");
    expect(members).toContain("package/dist/packed/decode.js");
    expect(members).toContain("package/dist/packed/decode.d.ts");
    expect(members).toContain("package/dist/packed/format.js");
    expect(members).toContain("package/dist/packed/format.d.ts");
    expect(members).toContain("package/dist/prepare.d.ts");
    expect(members).toContain("package/src/wgsl-types.d.ts");

    const manifest = JSON.parse(await readFile(join(fixture.wgslRoot, "package.json"), "utf8")) as any;
    const stdManifest = JSON.parse(await readFile(join(fixture.stdRoot, "package.json"), "utf8")) as any;
    expect(manifest.dependencies["@vgpu/wgsl-std"].replace(/^[~^]/u, "")).toBe(stdManifest.version);
    expect(manifest.exports["./_packed"]).toEqual(expect.objectContaining({
      types: "./dist/packed-metadata.d.ts",
      import: "./dist/packed-metadata.js",
      require: "./dist/packed-metadata.js",
    }));
    expect(manifest.exports["./_metadata.wgsl"]).toBe("./src/metadata.wgsl");
    expect(manifest.vgpuExportBundleBudgetsGzipBytes).not.toHaveProperty("./_metadata.wgsl");

    const authorDocs = [
      "src/loader-vite/index.docs.md",
      "src/loader-webpack/index.docs.md",
      "src/prepare.docs.md",
    ];
    for (const path of authorDocs) {
      const docs = await readFile(join(fixture.wgslRoot, path), "utf8");
      expect(docs).not.toContain("@vgpu/wgsl/_packed");
      expect(docs).not.toContain("@vgpu/wgsl/_metadata.wgsl");
    }
  });

  test("Node 22 resolves private implementation assets without widening public namespaces", async () => {
    const script = `
import * as root from "@vgpu/wgsl";
import * as prepare from "@vgpu/wgsl/prepare";
import { decodePackedMetadata } from "@vgpu/wgsl/_packed";
const decoded = decodePackedMetadata([1, [], [], null]);
console.log(JSON.stringify({
  decoded,
  rootPrivate: Object.hasOwn(root, "decodePackedMetadata"),
  preparePrivate: Object.hasOwn(prepare, "decodePackedMetadata"),
  preparePublic: typeof prepare.prepareShader,
}));
`;
    const { stdout } = await execFile(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: fixture.consumer,
      encoding: "utf8",
    });
    expect(JSON.parse(stdout)).toEqual({
      decoded: null,
      rootPrivate: false,
      preparePrivate: false,
      preparePublic: "function",
    });

    const consumerRequire = createRequire(join(fixture.consumer, "consumer.cjs"));
    expect(typeof consumerRequire("@vgpu/wgsl/_packed").decodePackedMetadata).toBe("function");
    expect(consumerRequire.resolve("@vgpu/wgsl/_packed")).toBe(join(fixture.wgslRoot, "dist/packed-metadata.js"));
    expect(consumerRequire.resolve("@vgpu/wgsl/_metadata.wgsl")).toBe(join(fixture.wgslRoot, "src/metadata.wgsl"));
  });

  test("the extracted helper is a bounded parser-free browser entry", async () => {
    const result = await esbuild({
      entryPoints: [join(fixture.wgslRoot, "dist/packed-metadata.js")],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      metafile: true,
      write: false,
    });
    const code = result.outputFiles[0]?.contents;
    if (!code) throw new Error("esbuild emitted no packed helper");
    const inputs = Object.keys(result.metafile.inputs).map(normalize);
    const manifest = JSON.parse(await readFile(join(fixture.wgslRoot, "package.json"), "utf8")) as any;
    const budget = manifest.vgpuExportBundleBudgetsGzipBytes["./_packed"];
    const gzip = gzipSync(code, { level: 9 }).byteLength;

    expect(gzip).toBeGreaterThan(0);
    expect(budget).toBeGreaterThan(0);
    expect(budget % 512).toBe(0);
    expect(gzip).toBeLessThanOrEqual(budget);
    expect(inputs.some((path) => path.endsWith("/dist/packed-metadata.js"))).toBe(true);
    expect(inputs.some((path) => path.endsWith("/dist/packed/decode.js"))).toBe(true);
    for (const forbidden of ["/packed/encode", "/prepare", "/scanner", "/parser", "/reflection", "/resolver", "node:"]) {
      expect(inputs.some((path) => path.includes(forbidden)), `unexpected helper input ${forbidden}`).toBe(false);
    }
  });

  test("packed Vite and webpack integrations reconstruct exact v2 artifacts", async () => {
    const source = packedConsumerShader();
    const sourcePath = join(fixture.consumer, "shader.wgsl");
    const entryPath = join(fixture.consumer, "entry.mjs");
    await writeFile(sourcePath, source);
    await writeFile(entryPath, 'import shader from "./shader.wgsl"; export default shader;\n');

    const viteLoader = await import(pathToFileURL(join(fixture.wgslRoot, "dist/loader-vite/index.js")).href) as {
      readonly default: (options?: unknown) => unknown;
    };
    const vite = await viteBuild({
      root: fixture.consumer,
      logLevel: "silent",
      plugins: [viteLoader.default()],
      build: {
        write: false,
        minify: false,
        lib: { entry: entryPath, formats: ["es"], fileName: "out" },
      },
    });
    const viteBundle = singleViteBundle(vite);
    expectPackedGraph(viteBundle.code, viteBundle.moduleIds, fixture.wgslRoot);
    expectNoWorkspacePackage(viteBundle.moduleIds);
    const viteArtifact = await importDataShader(viteBundle.code);
    expectExact(viteArtifact, sourcePath);

    const webpackOutput = join(fixture.consumer, "webpack-dist");
    const stats = await runWebpack({
      mode: "production",
      target: "node",
      context: fixture.consumer,
      entry: entryPath,
      output: { path: webpackOutput, filename: "bundle.cjs", library: { type: "commonjs2" } },
      module: { rules: [{ test: /\.wgsl$/u, loader: join(fixture.wgslRoot, "dist/loader-webpack/index.js") }] },
      optimization: { minimize: false },
    });
    expect(stats.hasErrors()).toBe(false);
    const webpackCode = await readFile(join(webpackOutput, "bundle.cjs"), "utf8");
    const webpackIds = webpackModuleIds(stats);
    expectPackedGraph(webpackCode, webpackIds, fixture.wgslRoot);
    expectNoWorkspacePackage(webpackIds);
    const webpackArtifact = require(join(webpackOutput, "bundle.cjs")) as { readonly default?: ShaderSource };
    expectExact(webpackArtifact.default ?? webpackArtifact as never, sourcePath);
  }, 30_000);

  test("a nested-only loader resolves its own helper, anchor and wgsl-std dependency", async () => {
    const nested = await createNestedConsumer(fixture);
    try {
      const sourcePath = join(nested.root, "shader.wgsl");
      const source = packedConsumerShader(true);
      await writeFile(sourcePath, source);
      const viteLoader = await import(`${pathToFileURL(join(nested.wgslRoot, "dist/loader-vite/index.js")).href}?nested=${Date.now()}`) as {
        readonly transformWgsl: (source: string, id: string) => Promise<{ readonly code: string }>;
      };
      const transformed = await viteLoader.transformWgsl(source, sourcePath);

      expect(await pathExists(join(nested.root, "node_modules/@vgpu/wgsl"))).toBe(false);
      expect(transformed.code).toContain(join(nested.wgslRoot, "dist/packed-metadata.js"));
      expect(transformed.code).toContain(join(nested.wgslRoot, "src/metadata.wgsl"));
      expect(transformed.code).not.toContain(join(workspaceWgsl, "dist"));

      const entry = join(nested.root, "entry.mjs");
      await writeFile(entry, 'import shader from "./shader.wgsl"; export default shader;\n');
      const vite = await viteBuild({
        root: nested.root,
        logLevel: "silent",
        plugins: [(await import(`${pathToFileURL(join(nested.wgslRoot, "dist/loader-vite/index.js")).href}?plugin=${Date.now()}`) as any).default()],
        build: { write: false, minify: false, lib: { entry, formats: ["es"], fileName: "out" } },
      });
      const viteBundle = singleViteBundle(vite);
      expectPackedGraph(viteBundle.code, viteBundle.moduleIds, nested.wgslRoot);
      expectNoWorkspacePackage(viteBundle.moduleIds);
      expectExact(await importDataShader(viteBundle.code), sourcePath);

      const webpackOutput = join(nested.root, "webpack-dist");
      const stats = await runWebpack({
        mode: "production",
        target: "node",
        context: nested.root,
        entry,
        output: { path: webpackOutput, filename: "bundle.cjs", library: { type: "commonjs2" } },
        module: { rules: [{ test: /\.wgsl$/u, loader: join(nested.wgslRoot, "dist/loader-webpack/index.js") }] },
        optimization: { minimize: false },
      });
      const webpackCode = await readFile(join(webpackOutput, "bundle.cjs"), "utf8");
      const webpackIds = webpackModuleIds(stats);
      expectPackedGraph(webpackCode, webpackIds, nested.wgslRoot);
      expectNoWorkspacePackage(webpackIds);
      const webpackArtifact = require(join(webpackOutput, "bundle.cjs")) as { readonly default?: ShaderSource };
      expectExact(webpackArtifact.default ?? webpackArtifact as never, sourcePath);
    } finally {
      await nested.dispose();
    }
  }, 30_000);
});

async function createPackedPackages(): Promise<{
  readonly root: string;
  readonly consumer: string;
  readonly wgslRoot: string;
  readonly stdRoot: string;
  readonly wgslTarball: string;
  readonly stdTarball: string;
  dispose(): Promise<void>;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-packed-package-")));
  const archives = join(root, "archives");
  const consumer = join(root, "consumer");
  const wgslRoot = join(consumer, "node_modules/@vgpu/wgsl");
  const stdRoot = join(consumer, "node_modules/@vgpu/wgsl-std");
  await mkdir(archives, { recursive: true });
  await Promise.all([
    execFile("pnpm", ["--dir", workspaceWgsl, "pack", "--pack-destination", archives], { encoding: "utf8" }),
    execFile("pnpm", ["--dir", workspaceWgslStd, "pack", "--pack-destination", archives], { encoding: "utf8" }),
  ]);
  const archivesList = await readdir(archives);
  const wgslTarball = join(archives, findTarball(archivesList, /^vgpu-wgsl-\d/u));
  const stdTarball = join(archives, findTarball(archivesList, /^vgpu-wgsl-std-\d/u));
  await Promise.all([
    extractTarball(wgslTarball, wgslRoot),
    extractTarball(stdTarball, stdRoot),
  ]);
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  return { root, consumer, wgslRoot, stdRoot, wgslTarball, stdTarball, dispose: () => rm(root, { recursive: true, force: true }) };
}

async function createNestedConsumer(packages: typeof fixture): Promise<{
  readonly root: string;
  readonly wgslRoot: string;
  dispose(): Promise<void>;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-packed-nested-")));
  const nestedScope = join(root, "node_modules/vgpu/node_modules/@vgpu");
  const wgslRoot = join(nestedScope, "wgsl");
  await Promise.all([
    extractTarball(packages.wgslTarball, wgslRoot),
    extractTarball(packages.stdTarball, join(nestedScope, "wgsl-std")),
  ]);
  await writeFile(join(root, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  return { root, wgslRoot, dispose: () => rm(root, { recursive: true, force: true }) };
}

async function extractTarball(tarball: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await execFile("tar", ["-xzf", tarball, "--strip-components=1", "-C", destination]);
}

async function tarMembers(tarball: string): Promise<string[]> {
  const { stdout } = await execFile("tar", ["-tzf", tarball], { encoding: "utf8" });
  return stdout.trim().split(/\r?\n/u);
}

function findTarball(files: readonly string[], pattern: RegExp): string {
  const file = files.find((item) => pattern.test(item) && item.endsWith(".tgz"));
  if (!file) throw new Error(`pnpm pack did not produce a tarball matching ${pattern}`);
  return file;
}

function packedConsumerShader(withStd = false): string {
  const members = Array.from({ length: 8 }, (_, index) => {
    const type = index % 3 === 0 ? "mat4x4f" : index % 3 === 1 ? "array<vec4f, 4>" : "vec4f";
    return `m${index}: ${type},`;
  }).join("\n");
  const bindings = Array.from({ length: 4 }, (_, index) =>
    `@group(0) @binding(${index}) var<uniform> params${index}: Params;`
  ).join("\n");
  return `${withStd ? 'import { pi } from "@vgpu/wgsl-std/constants";\n' : ""}
struct Params {\n${members}\n}
${bindings}
@compute @workgroup_size(1) fn main() { let value = params0.m0; ${withStd ? "_ = pi;" : ""} }
`;
}

function singleViteBundle(result: Awaited<ReturnType<typeof viteBuild>>): {
  readonly code: string;
  readonly moduleIds: readonly string[];
} {
  if ("on" in result) throw new Error("unexpected Vite watcher");
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((output: any) => output.output).filter((item: any) => item.type === "chunk");
  if (chunks.length !== 1) throw new Error(`expected one Vite chunk, received ${chunks.length}`);
  return {
    code: chunks[0].code,
    moduleIds: Object.keys(chunks[0].modules),
  };
}

function webpackModuleIds(stats: Stats): string[] {
  const json = stats.toJson({ all: false, modules: true, nestedModules: true });
  const result: string[] = [];
  const visit = (modules: readonly any[]) => {
    for (const module of modules) {
      result.push(String(module.identifier ?? module.name ?? ""));
      if (Array.isArray(module.modules)) visit(module.modules);
    }
  };
  visit(json.modules ?? []);
  return result;
}

function expectPackedGraph(code: string, moduleIds: readonly string[], wgslRoot: string): void {
  const root = normalize(wgslRoot);
  const normalized = moduleIds.map(normalize);
  expect(code).toContain("decodePackedMetadata");
  expect(normalized.some((id) =>
    id.includes(`${root}/dist/packed-metadata.js`)
    || id.includes(`${root}/dist/packed/decode.js`)
  )).toBe(true);
  expect(normalized.some((id) =>
    id.includes(`${root}/src/metadata.wgsl?__vgpu_packed_v1=`)
  )).toBe(true);
}

function expectNoWorkspacePackage(moduleIds: readonly string[]): void {
  const workspace = `${normalize(workspaceWgsl)}/`;
  expect(moduleIds.map(normalize).some((id) => id.includes(workspace))).toBe(false);
}

async function importDataShader(code: string): Promise<ShaderSource> {
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${Date.now()}-${Math.random()}`;
  return (await import(/* @vite-ignore */ url) as { readonly default: ShaderSource }).default;
}

function expectExact(artifact: ShaderSource, diagnosticPath: string): void {
  expect(artifact).toStrictEqual(prepareShader({
    wgsl: artifact.wgsl,
    functionExports: artifact.functionExports,
  }, diagnosticPath));
  expect(Buffer.byteLength(JSON.stringify(artifact.reflection))).toBeGreaterThanOrEqual(32 * 1024);
}

function runWebpack(config: Configuration): Promise<Stats> {
  return new Promise((resolveStats, reject) => {
    const compiler = webpack(config);
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error) return reject(error);
        if (closeError) return reject(closeError);
        if (!stats) return reject(new Error("webpack emitted no stats"));
        if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true, errorDetails: true })));
        resolveStats(stats);
      });
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(join(path, "package.json"));
    return true;
  } catch {
    return false;
  }
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}
