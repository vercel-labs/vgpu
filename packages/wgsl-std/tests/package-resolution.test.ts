import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

test("math, color, sampling, constants, hash, noise, and fullscreen package subpaths resolve through package exports", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { saturate } from "@vgpu/wgsl-std/math";
import { luminance } from "@vgpu/wgsl-std/color";
import { hammersley2d } from "@vgpu/wgsl-std/sampling";
import { pi } from "@vgpu/wgsl-std/constants";
import { hash1 } from "@vgpu/wgsl-std/hash";
import { voronoi2d } from "@vgpu/wgsl-std/noise";
import { fullscreenTriangleClip } from "@vgpu/wgsl-std/fullscreen";
fn main() -> f32 {
  let sample = hammersley2d(1u, 8u);
  let cell = voronoi2d(vec2f(0.25, 0.75));
  let clip = fullscreenTriangleClip(2u);
  return luminance(vec3f(saturate(1.5))) + sample.x + sample.y + pi + hash1(1.0) + cell.f1 + clip.x;
}`);

  const result = await resolveShader({ entry, validate: false });

  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/math/index.wgsl"))).toBe(true);
  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/color/index.wgsl"))).toBe(true);
  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/sampling/index.wgsl"))).toBe(true);
  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/constants/index.wgsl"))).toBe(true);
  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/hash/index.wgsl"))).toBe(true);
  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/noise/index.wgsl"))).toBe(true);
  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/fullscreen/index.wgsl"))).toBe(true);
  expect(result.wgsl).toContain("node_modules/@vgpu/wgsl-std/src/math/index.wgsl");
  expect(result.wgsl).toContain("node_modules/@vgpu/wgsl-std/src/color/index.wgsl");
  expect(result.wgsl).toContain("node_modules/@vgpu/wgsl-std/src/sampling/index.wgsl");
  expect(result.wgsl).toContain("node_modules/@vgpu/wgsl-std/src/constants/index.wgsl");
  expect(result.wgsl).toContain("node_modules/@vgpu/wgsl-std/src/hash/index.wgsl");
  expect(result.wgsl).toContain("node_modules/@vgpu/wgsl-std/src/noise/index.wgsl");
  expect(result.wgsl).toContain("node_modules/@vgpu/wgsl-std/src/fullscreen/index.wgsl");
  expect(result.wgsl).toMatch(/fn _vgsl_[0-9a-f]{8}__saturate\(value: f32\) -> f32/);
  expect(result.wgsl).toMatch(/fn _vgsl_[0-9a-f]{8}__luminance\(value: vec3f\) -> f32/);
  expect(result.wgsl).toMatch(/fn _vgsl_[0-9a-f]{8}__hammersley2d\(index: u32, count: u32\) -> vec2f/);
  expect(result.wgsl).toMatch(/const _vgsl_[0-9a-f]{8}__pi: f32/);
  expect(result.wgsl).toMatch(/fn _vgsl_[0-9a-f]{8}__hash1\(seed: f32\) -> f32/);
  expect(result.wgsl).toMatch(/fn _vgsl_[0-9a-f]{8}__voronoi2d\(position: vec2f\) -> _vgsl_[0-9a-f]{8}__VoronoiSample2/);
  expect(result.wgsl).toMatch(/fn _vgsl_[0-9a-f]{8}__fullscreenTriangleClip\(index: u32\) -> vec4f/);
});

test("structs imported from a package subpath can type bindings and struct members (#212)", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { VoronoiSample2, VoronoiSample3, voronoi2d, voronoi3d } from "@vgpu/wgsl-std/noise";

struct Report {
  flat: VoronoiSample2,
  volume: VoronoiSample3,
}

@group(0) @binding(0) var<storage, read_write> report: Report;
@group(0) @binding(1) var<storage, read_write> latest: VoronoiSample2;

@compute @workgroup_size(1) fn main() {
  report.flat = voronoi2d(vec2f(0.5, 0.25));
  report.volume = voronoi3d(vec3f(0.5, 0.25, 0.125));
  latest = report.flat;
}`);

  const { reflection } = await resolveShader({ entry, validate: false });
  const [report, latest] = reflection.bindings;

  expect(report?.layout?.members?.map((member) => [member.name, member.offset, member.size])).toEqual([
    ["flat", 0, 16],
    ["volume", 16, 32],
  ]);
  expect(latest?.struct?.name).toBe("VoronoiSample2");
  expect(latest?.layout?.members?.map((member) => [member.name, member.offset])).toEqual([
    ["f1", 0],
    ["f2", 4],
    ["cell", 8],
  ]);
});

test("wgsl-std has no root WGSL export", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { saturate } from "@vgpu/wgsl-std";
fn main() -> f32 { return saturate(1.0); }`);

  await expect(resolveShader({ entry, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-PKG-NOTFOUND" });
});

test("resolved wgsl-std output is deterministic when minified", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { saturate } from "@vgpu/wgsl-std/math";
fn main() -> f32 {
  return saturate(1.5);
}`);

  const first = await resolveShader({ entry, validate: false, minify: true });
  const second = await resolveShader({ entry, validate: false, minify: true });

  expect(first.wgsl).toBe(second.wgsl);
  expect(first.wgsl).not.toContain("\n");
  expect(first.wgsl).not.toContain("//");
  const compact = first.wgsl.replace(/\s+/gu, "");
  expect(compact).toMatch(/^fna\(\)->f32\{returnb\(1\.5\);\}/u);
  expect(compact).toContain("returnclamp(");
  expect(compact).not.toContain("normalize(");
  expect(compact).not.toContain("vec2f(");
  expect(compact).not.toMatch(/inverseLerp|remap|safeNormalize|rotate2d/u);
});

test("scene helpers resolve from the package export without injecting resources", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "scene.wgsl");
  await writeFile(entry, `import { instanceWorldMatrix, transformPosition, transformDirection, transformNormal } from "@vgpu/wgsl-std/scene";
fn applyScene(world0: vec4f, world1: vec4f, world2: vec4f, world3: vec4f, value: vec3f) -> vec3f {
  let world = instanceWorldMatrix(world0, world1, world2, world3);
  return transformPosition(world, value) + transformDirection(world, value) + transformNormal(world, value);
}`);

  const resolved = await resolveShader({ entry, validate: false });
  const first = await resolveShader({ entry, validate: false, minify: true });
  const second = await resolveShader({ entry, validate: false, minify: true });

  expect(resolved.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/scene/index.wgsl"))).toBe(true);
  expect(resolved.reflection.bindings).toEqual([]);
  expect(first.wgsl).toBe(second.wgsl);
  for (const helper of ["instanceWorldMatrix", "transformPosition", "transformDirection", "transformNormal"]) {
    expect(resolved.wgsl).toContain(helper);
  }
});

test("importing @vgpu/wgsl-std/noise/perlin does not pull in simplex, and vice versa", async () => {
  const dir = await workspaceFixture();

  const perlinEntry = join(dir, "app", "perlin.wgsl");
  await writeFile(perlinEntry, `import { perlin2d } from "@vgpu/wgsl-std/noise/perlin";
fn main() -> f32 { return perlin2d(vec2f(0.25, 0.75)); }`);
  const perlinResult = await resolveShader({ entry: perlinEntry, validate: false });

  expect(perlinResult.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/noise/perlin/index.wgsl"))).toBe(true);
  expect(perlinResult.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/noise/internal/gradient.wgsl"))).toBe(true);
  expect(perlinResult.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/hash/index.wgsl"))).toBe(true);
  expect(perlinResult.deps.some((dep) => dep.includes("/noise/simplex/"))).toBe(false);
  expect(stripWgslComments(perlinResult.wgsl).toLowerCase()).not.toContain("simplex");

  const simplexEntry = join(dir, "app", "simplex.wgsl");
  await writeFile(simplexEntry, `import { simplex2d } from "@vgpu/wgsl-std/noise/simplex";
fn main() -> f32 { return simplex2d(vec2f(0.25, 0.75)); }`);
  const simplexResult = await resolveShader({ entry: simplexEntry, validate: false });

  expect(simplexResult.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/noise/simplex/index.wgsl"))).toBe(true);
  expect(simplexResult.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/noise/internal/gradient.wgsl"))).toBe(true);
  expect(simplexResult.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/hash/index.wgsl"))).toBe(true);
  expect(simplexResult.deps.some((dep) => dep.includes("/noise/perlin/"))).toBe(false);
  expect(stripWgslComments(simplexResult.wgsl).toLowerCase()).not.toContain("perlin");
});

test("importing both noise/perlin and noise/simplex resolves each module's declarations exactly once", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { perlin2d } from "@vgpu/wgsl-std/noise/perlin";
import { simplex2d } from "@vgpu/wgsl-std/noise/simplex";
fn main() -> f32 { return perlin2d(vec2f(0.25, 0.75)) + simplex2d(vec2f(0.25, 0.75)); }`);

  const result = await resolveShader({ entry, validate: false });
  const wgsl = stripWgslComments(result.wgsl);

  for (const symbol of ["gradIndex2", "gradDot2", "gradIndex3", "gradDot3", "noiseFade2", "noiseFade3"]) {
    const occurrences = wgsl.match(new RegExp(`fn _vgsl_[0-9a-f]{8}__${symbol}\\(`, "gu")) ?? [];
    expect(occurrences.length).toBe(1);
  }
});

function stripWgslComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/[^\n]*/gu, " ");
}

async function workspaceFixture(): Promise<string> {
  const dir = await mkdirTemp();
  await mkdir(join(dir, "app"), { recursive: true });
  await mkdir(join(dir, "node_modules", "@vgpu"), { recursive: true });
  await symlink(resolve("packages/wgsl-std"), join(dir, "node_modules", "@vgpu", "wgsl-std"), "dir");
  return dir;
}

async function mkdirTemp(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "vgpu-wgsl-std-"));
}
