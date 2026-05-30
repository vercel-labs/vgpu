import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

test("math and color package subpaths resolve through package exports", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { saturate } from "@vgpu/wgsl-std/math";
import { identityVec3f } from "@vgpu/wgsl-std/color";
fn main() -> vec3f {
  return identityVec3f(vec3f(saturate(1.5)));
}`);

  const result = await resolveShader({ entry, validate: false });

  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/math/index.wgsl"))).toBe(true);
  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/color/index.wgsl"))).toBe(true);
  expect(result.wgsl).toContain("node_modules/@vgpu/wgsl-std/src/math/index.wgsl");
  expect(result.wgsl).toContain("node_modules/@vgpu/wgsl-std/src/color/index.wgsl");
  expect(result.wgsl).toMatch(/fn _vgsl_[0-9a-f]{8}__saturate\(value: f32\) -> f32/);
  expect(result.wgsl).toMatch(/fn _vgsl_[0-9a-f]{8}__identityVec3f\(value: vec3f\) -> vec3f/);
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
