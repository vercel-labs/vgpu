import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

const dockerTest = process.env.VGPU_DOCKER_TEST === "1";

describe("CPU reference fullscreen catalog", () => {
  test("fullscreenTriangleClip emits the oversized single-triangle positions", () => {
    expectVec4Close(fullscreenTriangleClipRef(0), [-1, -3, 0, 1], "index 0");
    expectVec4Close(fullscreenTriangleClipRef(1), [-1, 1, 0, 1], "index 1");
    expectVec4Close(fullscreenTriangleClipRef(2), [3, 1, 0, 1], "index 2");
  });

  test("fullscreenTriangleUv maps clip xy to top-left texture uv coordinates", () => {
    expectVec2Close(fullscreenTriangleUvRef([-1, 1]), [0, 0], "top-left");
    expectVec2Close(fullscreenTriangleUvRef([1, 1]), [1, 0], "top-right");
    expectVec2Close(fullscreenTriangleUvRef([-1, -1]), [0, 1], "bottom-left");
    expectVec2Close(fullscreenTriangleUvRef([0, 0]), [0.5, 0.5], "center");
  });
});

test("fullscreen helpers resolve from @vgpu/wgsl-std/fullscreen and produce valid declarations", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { fullscreenTriangleClip, fullscreenTriangleUv } from "@vgpu/wgsl-std/fullscreen";
fn main() -> vec4f {
  let clip = fullscreenTriangleClip(2u);
  return vec4f(fullscreenTriangleUv(clip.xy), clip.zw);
}`);

  const result = await resolveShader({ entry, validate: false });

  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/fullscreen/index.wgsl"))).toBe(true);
  for (const name of ["fullscreenTriangleClip", "fullscreenTriangleUv"]) {
    expect.soft(result.wgsl, name).toMatch(new RegExp(`fn _vgsl_[0-9a-f]{8}__${name}\\(`, "u"));
  }
});

test("fullscreen helper minified output is deterministic", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { fullscreenTriangleClip } from "@vgpu/wgsl-std/fullscreen";
fn main() -> vec4f {
  return fullscreenTriangleClip(1u);
}`);

  const first = await resolveShader({ entry, validate: false, minify: true });
  const second = await resolveShader({ entry, validate: false, minify: true });

  expect(first.wgsl).toBe(second.wgsl);
  expect(first.wgsl).not.toContain("\n");
  expect(first.wgsl).not.toContain("//");
  expect(first.wgsl).toContain("*4.0-1.0");
  expect(first.wgsl).toContain("*4.0-3.0");
});

test.skipIf(!dockerTest)("resolved fullscreen utility shader validates with naga", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { fullscreenTriangleClip, fullscreenTriangleUv } from "@vgpu/wgsl-std/fullscreen";
@compute @workgroup_size(1)
fn main() {
  let clip = fullscreenTriangleClip(2u);
  let uv = fullscreenTriangleUv(clip.xy);
}`);

  await expect(resolveShader({ entry })).resolves.toHaveProperty("wgsl");
});

function fullscreenTriangleClipRef(index: number): [number, number, number, number] {
  return [Math.floor(index / 2) * 4 - 1, Math.min(index, 1) * 4 - 3, 0, 1];
}

function fullscreenTriangleUvRef(clipXy: readonly [number, number]): [number, number] {
  return [clipXy[0] * 0.5 + 0.5, clipXy[1] * -0.5 + 0.5];
}

function expectVec2Close(actual: readonly [number, number], expected: readonly [number, number], name: string): void {
  expect.soft(actual[0], `${name}.x`).toBeCloseTo(expected[0], 12);
  expect.soft(actual[1], `${name}.y`).toBeCloseTo(expected[1], 12);
}

function expectVec4Close(actual: readonly [number, number, number, number], expected: readonly [number, number, number, number], name: string): void {
  expect.soft(actual[0], `${name}.x`).toBeCloseTo(expected[0], 12);
  expect.soft(actual[1], `${name}.y`).toBeCloseTo(expected[1], 12);
  expect.soft(actual[2], `${name}.z`).toBeCloseTo(expected[2], 12);
  expect.soft(actual[3], `${name}.w`).toBeCloseTo(expected[3], 12);
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
