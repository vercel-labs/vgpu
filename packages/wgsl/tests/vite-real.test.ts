import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import wgslVitePlugin from "@vgpu/wgsl/loader-vite";
import { build, type InlineConfig } from "vite";
import { describe, expect, it, vi } from "vitest";
import type { ShaderSource } from "@vgpu/wgsl";

describe("wgslVitePlugin (real installed Vite)", () => {
  it("transforms .wgsl imports through wgslVitePlugin", async () => {
    const { root, entryJs } = await writeFixture();
    const config: InlineConfig = {
      root,
      logLevel: "silent",
      plugins: [wgslVitePlugin()],
      build: {
        write: false,
        minify: false,
        lib: { entry: entryJs, formats: ["es"], fileName: "out" },
      },
    };

    const result = await build(config);
    const outputs = Array.isArray(result) ? result : [result];
    const code = outputs.flatMap((output) => output.output)
      .filter((chunk) => chunk.type === "chunk")
      .map((chunk) => chunk.code)
      .join("\n");

    expect(code).toContain("helper_color");
    expect(code).toContain("main_color");
    expect(code).toContain("return _vgsl_");
    expect(code).not.toContain("prepareShader");
    expect(code).not.toContain("reflectSource");
    expectPreparedShaderSource(await importBuiltShaderSource(code));
  });

  it("honors the minify plugin option in a real vite build", async () => {
    const { root, entryJs } = await writeFixture();
    const config: InlineConfig = {
      root,
      logLevel: "silent",
      plugins: [wgslVitePlugin({ minify: true })],
      build: {
        write: false,
        minify: false,
        lib: { entry: entryJs, formats: ["es"], fileName: "out" },
      },
    };

    const result = await build(config);
    const outputs = Array.isArray(result) ? result : [result];
    const entryChunk = outputs.flatMap((output) => output.output)
      .find((chunk) => chunk.type === "chunk" && chunk.isEntry);
    if (!entryChunk || entryChunk.type !== "chunk") throw new Error("Vite build emitted no entry chunk");
    const dataUrl = `data:text/javascript;base64,${Buffer.from(entryChunk.code).toString("base64")}`;
    const builtModule = await import(/* @vite-ignore */ dataUrl) as { readonly default: ShaderSource };
    const wgsl = builtModule.default.wgsl;

    expect(wgsl).not.toContain("helper_color");
    expect(wgsl).toContain("return b();");
    expect(wgsl).toContain("fn a()-> vec4f");
    expect(wgsl).not.toContain("helper comment");
    expect(wgsl).not.toContain("entry comment");
  });

  it("triggers re-compile via addWatchFile when a transitively imported .wgsl changes", async () => {
    const { entryWgsl, helperWgsl } = await writeFixture();
    const plugin = wgslVitePlugin();
    const addWatchFile = vi.fn();

    await plugin.transform.call({ addWatchFile }, await readFile(entryWgsl, "utf8"), entryWgsl);

    expect(addWatchFile).toHaveBeenCalledWith(helperWgsl);
    expect(addWatchFile).not.toHaveBeenCalledWith(entryWgsl);
  });

  it("emits fresh bundled WGSL when a watched import changes between builds", async () => {
    const { root, entryJs, helperWgsl } = await writeFixture();
    const config: InlineConfig = {
      root,
      logLevel: "silent",
      plugins: [wgslVitePlugin()],
      build: {
        write: false,
        minify: false,
        lib: { entry: entryJs, formats: ["es"], fileName: "out" },
      },
    };

    const first = await build(config);
    await writeFile(helperWgsl, "export fn helper_color() -> vec4f { return vec4f(0.9, 0.8, 0.7, 1.0); }");
    const second = await build(config);
    const firstCode = entryChunkCode(first);
    const secondCode = entryChunkCode(second);

    expect(firstCode).toContain("0.4, 0.5, 0.6, 1.0");
    expect(secondCode).not.toBe(firstCode);
    expect(secondCode).toContain("0.9, 0.8, 0.7, 1.0");
    expectPreparedShaderSource(await importBuiltShaderSource(secondCode));
  });

  it("bundles packed reflection through the packaged decoder and metadata anchor", async () => {
    const { root, entryJs } = await writePackedFixture();
    const result = await build({
      root,
      logLevel: "silent",
      plugins: [wgslVitePlugin()],
      build: {
        write: false,
        minify: false,
        lib: { entry: entryJs, formats: ["es"], fileName: "out" },
      },
    });
    const code = entryChunkCode(result);
    const shader = await importBuiltShaderSource(code);
    const modules = entryChunkModules(result);

    expect(shader.reflection.bindings).toHaveLength(4);
    expect(shader.reflection.hostShareableLayouts[0]?.members).toHaveLength(8);
    expect(code).not.toContain("prepareShader");
    expect(code).not.toContain("reflectSource");
    expect(modules).toContain("metadata.wgsl?__vgpu_packed_v1=");
    expectPreparedShaderSource(shader);
  });
});

async function writeFixture(): Promise<{ root: string; entryJs: string; entryWgsl: string; helperWgsl: string }> {
  const root = await mkdtemp(join(tmpdir(), "vgsl-vite-"));
  const entryWgsl = join(root, "entry.wgsl");
  const helperWgsl = join(root, "helper.wgsl");
  await writeFile(helperWgsl, "// helper comment\nexport fn helper_color() -> vec4f { return vec4f(0.4, 0.5, 0.6, 1.0); }");
  await writeFile(entryWgsl, `import { helper_color } from "./helper.wgsl";
// entry comment
fn main_color() -> vec4f { return helper_color(); }`);
  await writeFile(join(root, "entry.js"), `import shader from "./entry.wgsl";
export default shader;`);
  return { root, entryJs: join(root, "entry.js"), entryWgsl, helperWgsl };
}

async function writePackedFixture(): Promise<{ root: string; entryJs: string }> {
  const root = await mkdtemp(join(tmpdir(), "vgsl-vite-packed-"));
  const members = Array.from({ length: 8 }, (_, index) => {
    const type = index % 3 === 0 ? "mat4x4f" : index % 3 === 1 ? "array<vec4f, 4>" : "vec4f";
    return `m${index}: ${type},`;
  }).join("\n");
  const bindings = Array.from({ length: 4 }, (_, index) =>
    `@group(0) @binding(${index}) var<uniform> params${index}: Params;`
  ).join("\n");
  await writeFile(join(root, "entry.wgsl"), `struct Params {\n${members}\n}
${bindings}
@compute @workgroup_size(1) fn main() { let value = params0.m0; }`);
  await writeFile(join(root, "entry.js"), `import shader from "./entry.wgsl";\nexport default shader;`);
  return { root, entryJs: join(root, "entry.js") };
}

function entryChunkCode(result: Awaited<ReturnType<typeof build>>): string {
  const outputs = Array.isArray(result) ? result : [result];
  const entryChunk = outputs.flatMap((output) => output.output)
    .find((chunk) => chunk.type === "chunk" && chunk.isEntry);
  if (!entryChunk || entryChunk.type !== "chunk") throw new Error("Vite build emitted no entry chunk");
  return entryChunk.code;
}

function entryChunkModules(result: Awaited<ReturnType<typeof build>>): string {
  const outputs = Array.isArray(result) ? result : [result];
  const entryChunk = outputs.flatMap((output) => output.output)
    .find((chunk) => chunk.type === "chunk" && chunk.isEntry);
  if (!entryChunk || entryChunk.type !== "chunk") throw new Error("Vite build emitted no entry chunk");
  return Object.keys(entryChunk.modules).join("\n");
}

async function importBuiltShaderSource(code: string): Promise<ShaderSource> {
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  return (await import(/* @vite-ignore */ dataUrl) as { readonly default: ShaderSource }).default;
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
