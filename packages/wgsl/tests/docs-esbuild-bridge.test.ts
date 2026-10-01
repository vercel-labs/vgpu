import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { prepareShader } from "@vgpu/wgsl/prepare";
import type { ShaderSource } from "@vgpu/wgsl";
import { docsWgslPlugin } from "../../../apps/docs/scripts/esbuild-wgsl-plugin.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const FORBIDDEN_BUNDLE_INPUTS = [
  "/packed/encode",
  "/loader-shared/packed-selection",
  "/loader-shared/packed-query",
  "/prepare",
  "/scanner",
  "/parser",
  "/reflection",
  "/resolver",
  "/runtime/",
] as const;

test("esbuild transforms shared packed metadata requests into an exact parser-free artifact", async () => {
  const source = packedShader();
  const result = await bundleShader(source, "packed");

  expect(result.artifact).toStrictEqual({
    ...prepareShader(source, result.shaderPath),
    functionExports: [],
  });
  expect(result.inputs.filter((input) => input.includes("?__vgpu_packed_v1="))).not.toHaveLength(0);
  expect(result.code).toContain("decodePackedMetadata");
  for (const forbidden of FORBIDDEN_BUNDLE_INPUTS) {
    expect(result.inputs.some((input) => input.includes(forbidden)), `unexpected packed input ${forbidden}`).toBe(false);
  }
});

test("esbuild keeps an ineligible WGSL import on the exact literal parser-free path", async () => {
  const source = plainShader();
  const result = await bundleShader(source, "plain");

  expect(result.artifact).toStrictEqual({
    ...prepareShader(source, result.shaderPath),
    functionExports: [],
  });
  expect(result.inputs.some((input) => input.includes("?__vgpu_packed_v1="))).toBe(false);
  expect(result.inputs.some((input) => input.includes("/packed-metadata"))).toBe(false);
  expect(result.code).not.toContain("decodePackedMetadata");
  for (const forbidden of FORBIDDEN_BUNDLE_INPUTS) {
    expect(result.inputs.some((input) => input.includes(forbidden)), `unexpected plain input ${forbidden}`).toBe(false);
  }
});

test("esbuild bundles the real atmosphere renderer through shared metadata without initializing a GPU", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-docs-atmosphere-esbuild-")));
  const bundlePath = join(root, "atmosphere.mjs");
  try {
    const result = await build({
      entryPoints: [join(REPO_ROOT, "apps/docs/examples/atmosphere/renderer.ts")],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
      metafile: true,
      external: ["vgpu", "vgpu/node"],
      plugins: [docsWgslPlugin()],
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs).map(normalizePath);
    expect(inputs.some((input) => input.includes("?__vgpu_packed_v1="))).toBe(true);
    expect(await readFile(bundlePath, "utf8")).toContain("decodePackedMetadata");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function bundleShader(source: string, name: string): Promise<{
  readonly artifact: ShaderSource;
  readonly code: string;
  readonly inputs: readonly string[];
  readonly shaderPath: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-docs-esbuild-wgsl-")));
  const sourceDir = join(root, "src");
  const shaderPath = join(sourceDir, `${name}.wgsl`);
  const entryPath = join(sourceDir, "entry.mjs");
  const bundlePath = join(root, `${name}.mjs`);
  try {
    await mkdir(sourceDir, { recursive: true });
    await Promise.all([
      writeFile(shaderPath, source),
      writeFile(entryPath, `import shader from ${JSON.stringify(`./${name}.wgsl`)}; export default shader;\n`),
    ]);
    const result = await build({
      entryPoints: [entryPath],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
      metafile: true,
      plugins: [docsWgslPlugin()],
      logLevel: "silent",
    });
    const artifact = (await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}-${Math.random()}`) as {
      readonly default: ShaderSource;
    }).default;
    return {
      artifact,
      code: await readFile(bundlePath, "utf8"),
      inputs: Object.keys(result.metafile.inputs).map(normalizePath),
      shaderPath,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function packedShader(): string {
  const members = Array.from({ length: 8 }, (_, index) => {
    const type = index % 3 === 0 ? "mat4x4f" : index % 3 === 1 ? "array<vec4f, 4>" : "vec4f";
    return `  m${index}: ${type},`;
  }).join("\n");
  const bindings = Array.from({ length: 4 }, (_, index) =>
    `@group(0) @binding(${index}) var<uniform> params${index}: Params;`
  ).join("\n");
  return `struct Params {\n${members}\n}\n${bindings}\n@compute @workgroup_size(1) fn main() { _ = params0.m0; }\n`;
}

function plainShader(): string {
  const members = Array.from({ length: 16 }, (_, index) => {
    const type = index % 3 === 0 ? "mat4x4f" : index % 3 === 1 ? "array<vec4f, 4>" : "vec4f";
    return `  m${index}: ${type},`;
  }).join("\n");
  return `struct Params {\n${members}\n}\n@group(0) @binding(0) var<uniform> params: Params;\n@compute @workgroup_size(1) fn main() { _ = params.m0; }\n`;
}
