import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { resolveShader } from "@vgpu/wgsl/runtime";

const dockerTest = process.env.VGPU_DOCKER_TEST === "1";

interface ScalarCase {
  readonly name: string;
  readonly actual: number;
  readonly expected: number;
}

interface Vec2Case {
  readonly name: string;
  readonly actual: readonly [number, number];
  readonly expected: readonly [number, number];
}

interface Vec3Case {
  readonly name: string;
  readonly actual: readonly [number, number, number];
  readonly expected: readonly [number, number, number];
}

interface Vec4Case {
  readonly name: string;
  readonly actual: readonly [number, number, number, number];
  readonly expected: readonly [number, number, number, number];
}

describe("CPU reference math catalog", () => {
  test("scalar helpers define deterministic edge behavior", () => {
    const cases: readonly ScalarCase[] = [
      { name: "saturate below", actual: saturateRef(-0.25), expected: 0 },
      { name: "saturate within", actual: saturateRef(0.375), expected: 0.375 },
      { name: "saturate above", actual: saturateRef(1.25), expected: 1 },
      { name: "clamp01 alias", actual: clamp01Ref(1.25), expected: saturateRef(1.25) },
      { name: "inverseLerp midpoint", actual: inverseLerpRef(2, 6, 4), expected: 0.5 },
      { name: "inverseLerp unclamped", actual: inverseLerpRef(2, 6, 10), expected: 2 },
      { name: "inverseLerp zero range", actual: inverseLerpRef(2, 2, 10), expected: 0 },
      { name: "remap midpoint", actual: remapRef(0, 10, -1, 1, 5), expected: 0 },
      { name: "remap zero input range", actual: remapRef(2, 2, 4, 8, 10), expected: 4 },
    ];

    for (const { name, actual, expected } of cases) {
      expect.soft(actual, name).toBeCloseTo(expected, 6);
    }
  });

  test("vector helpers define safe normalize and rotation behavior", () => {
    const vec2Cases: readonly Vec2Case[] = [
      { name: "safeNormalize2 non-zero", actual: safeNormalize2Ref([3, 4], [1, 0]), expected: [0.6, 0.8] },
      { name: "safeNormalize2 zero fallback", actual: safeNormalize2Ref([0, 0], [1, 0]), expected: [1, 0] },
      { name: "rotate2d quarter turn", actual: rotate2dRef([1, 0], Math.PI / 2), expected: [0, 1] },
    ];
    const vec3Cases: readonly Vec3Case[] = [
      { name: "safeNormalize3 non-zero", actual: safeNormalize3Ref([2, 0, 0], [0, 1, 0]), expected: [1, 0, 0] },
      { name: "safeNormalize3 zero fallback", actual: safeNormalize3Ref([0, 0, 0], [0, 1, 0]), expected: [0, 1, 0] },
    ];
    const vec4Cases: readonly Vec4Case[] = [
      { name: "safeNormalize4 non-zero", actual: safeNormalize4Ref([0, 0, 0, 5], [0, 0, 1, 0]), expected: [0, 0, 0, 1] },
      { name: "safeNormalize4 zero fallback", actual: safeNormalize4Ref([0, 0, 0, 0], [0, 0, 1, 0]), expected: [0, 0, 1, 0] },
    ];

    for (const { name, actual, expected } of vec2Cases) {
      expectVec2Close(actual, expected, name);
    }
    for (const { name, actual, expected } of vec3Cases) {
      expectVec3Close(actual, expected, name);
    }
    for (const { name, actual, expected } of vec4Cases) {
      expectVec4Close(actual, expected, name);
    }
  });
});

test("math helpers resolve from @vgpu/wgsl-std/math and produce valid declarations", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { saturate, clamp01, inverseLerp, remap, safeNormalize2, safeNormalize3, safeNormalize4, rotate2d } from "@vgpu/wgsl-std/math";
fn main() -> vec4f {
  let scalar = saturate(-0.5) + clamp01(1.5) + inverseLerp(2.0, 6.0, 4.0) + remap(0.0, 10.0, -1.0, 1.0, 5.0);
  let v2 = rotate2d(safeNormalize2(vec2f(3.0, 4.0), vec2f(1.0, 0.0)), 1.5707963267948966);
  let v3 = safeNormalize3(vec3f(0.0), vec3f(0.0, 1.0, 0.0));
  let v4 = safeNormalize4(vec4f(0.0), vec4f(0.0, 0.0, 1.0, 0.0));
  return vec4f(scalar + v2.x + v3.y + v4.z, v2.y, v3.y, v4.z);
}`);

  const result = await resolveShader({ entry, validate: false });

  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/math/index.wgsl"))).toBe(true);
  for (const name of ["saturate", "clamp01", "inverseLerp", "remap", "safeNormalize2", "safeNormalize3", "safeNormalize4", "rotate2d"]) {
    expect.soft(result.wgsl, name).toMatch(new RegExp(`fn _vgsl_[0-9a-f]{8}__${name}\\(`, "u"));
  }
  expect(result.wgsl).not.toContain("identityF32");
});

test("math helper minified output is deterministic", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { saturate, remap } from "@vgpu/wgsl-std/math";
fn main() -> f32 {
  return saturate(remap(0.0, 10.0, -1.0, 1.0, 12.0));
}`);

  const first = await resolveShader({ entry, validate: false, minify: true });
  const second = await resolveShader({ entry, validate: false, minify: true });

  expect(first.wgsl).toBe(second.wgsl);
  expect(first.wgsl).not.toContain("\n");
  expect(first.wgsl).not.toContain("//");
  expect(first.wgsl).toContain("clamp(");
});

test.skipIf(!dockerTest)("resolved math utility shader validates with naga", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { saturate, safeNormalize2, rotate2d } from "@vgpu/wgsl-std/math";
@compute @workgroup_size(1)
fn main() {
  let value = saturate(rotate2d(safeNormalize2(vec2f(1.0, 0.0), vec2f(0.0, 1.0)), 0.5).x);
}`);

  await expect(resolveShader({ entry })).resolves.toHaveProperty("wgsl");
});

test.skipIf(!dockerTest)("math helpers match CPU references in a tiny compute shader", async () => {
  const values = await runMathCompute();
  const expected = new Float32Array([
    saturateRef(-0.25),
    saturateRef(1.25),
    inverseLerpRef(2, 6, 4),
    inverseLerpRef(2, 2, 10),
    remapRef(0, 10, -1, 1, 5),
    remapRef(2, 2, 4, 8, 10),
    ...safeNormalize2Ref([3, 4], [1, 0]),
    ...safeNormalize2Ref([0, 0], [1, 0]),
    ...rotate2dRef([1, 0], Math.PI / 2),
  ]);

  expect(values.length).toBe(expected.length);
  values.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index], 4);
  });
});

function saturateRef(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function clamp01Ref(value: number): number {
  return saturateRef(value);
}

function inverseLerpRef(from: number, to: number, value: number): number {
  const denominator = to - from;
  return denominator === 0 ? 0 : (value - from) / denominator;
}

function remapRef(inMin: number, inMax: number, outMin: number, outMax: number, value: number): number {
  return outMin + inverseLerpRef(inMin, inMax, value) * (outMax - outMin);
}

function safeNormalize2Ref(value: readonly [number, number], fallback: readonly [number, number]): [number, number] {
  const lengthSq = value[0] * value[0] + value[1] * value[1];
  if (lengthSq <= 0) return [fallback[0], fallback[1]];
  const invLength = 1 / Math.sqrt(lengthSq);
  return [value[0] * invLength, value[1] * invLength];
}

function safeNormalize3Ref(value: readonly [number, number, number], fallback: readonly [number, number, number]): [number, number, number] {
  const lengthSq = value[0] * value[0] + value[1] * value[1] + value[2] * value[2];
  if (lengthSq <= 0) return [fallback[0], fallback[1], fallback[2]];
  const invLength = 1 / Math.sqrt(lengthSq);
  return [value[0] * invLength, value[1] * invLength, value[2] * invLength];
}

function safeNormalize4Ref(value: readonly [number, number, number, number], fallback: readonly [number, number, number, number]): [number, number, number, number] {
  const lengthSq = value[0] * value[0] + value[1] * value[1] + value[2] * value[2] + value[3] * value[3];
  if (lengthSq <= 0) return [fallback[0], fallback[1], fallback[2], fallback[3]];
  const invLength = 1 / Math.sqrt(lengthSq);
  return [value[0] * invLength, value[1] * invLength, value[2] * invLength, value[3] * invLength];
}

function rotate2dRef(value: readonly [number, number], radians: number): [number, number] {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [value[0] * c - value[1] * s, value[0] * s + value[1] * c];
}

function expectVec2Close(actual: readonly [number, number], expected: readonly [number, number], name: string): void {
  expect.soft(actual[0], `${name}.x`).toBeCloseTo(expected[0], 6);
  expect.soft(actual[1], `${name}.y`).toBeCloseTo(expected[1], 6);
}

function expectVec3Close(actual: readonly [number, number, number], expected: readonly [number, number, number], name: string): void {
  expect.soft(actual[0], `${name}.x`).toBeCloseTo(expected[0], 6);
  expect.soft(actual[1], `${name}.y`).toBeCloseTo(expected[1], 6);
  expect.soft(actual[2], `${name}.z`).toBeCloseTo(expected[2], 6);
}

function expectVec4Close(actual: readonly [number, number, number, number], expected: readonly [number, number, number, number], name: string): void {
  expect.soft(actual[0], `${name}.x`).toBeCloseTo(expected[0], 6);
  expect.soft(actual[1], `${name}.y`).toBeCloseTo(expected[1], 6);
  expect.soft(actual[2], `${name}.z`).toBeCloseTo(expected[2], 6);
  expect.soft(actual[3], `${name}.w`).toBeCloseTo(expected[3], 6);
}

async function runMathCompute(): Promise<Float32Array> {
  const outputLength = 12;
  const outputSize = outputLength * Float32Array.BYTES_PER_ELEMENT;
  const mathPath = resolve("packages/wgsl-std/src/math/index.wgsl");
  const modules = {
    "/main.wgsl": `import { saturate, inverseLerp, remap, safeNormalize2, rotate2d } from "@vgpu/wgsl-std/math";
struct Out { values: array<f32, ${outputLength}> }
@group(0) @binding(0) var<storage, read_write> out: Out;
@compute @workgroup_size(1)
fn main() {
  out.values[0] = saturate(-0.25);
  out.values[1] = saturate(1.25);
  out.values[2] = inverseLerp(2.0, 6.0, 4.0);
  out.values[3] = inverseLerp(2.0, 2.0, 10.0);
  out.values[4] = remap(0.0, 10.0, -1.0, 1.0, 5.0);
  out.values[5] = remap(2.0, 2.0, 4.0, 8.0, 10.0);
  let n = safeNormalize2(vec2f(3.0, 4.0), vec2f(1.0, 0.0));
  out.values[6] = n.x;
  out.values[7] = n.y;
  let z = safeNormalize2(vec2f(0.0), vec2f(1.0, 0.0));
  out.values[8] = z.x;
  out.values[9] = z.y;
  let r = rotate2d(vec2f(1.0, 0.0), 1.5707963267948966);
  out.values[10] = r.x;
  out.values[11] = r.y;
}`,
    [mathPath]: await readFile(mathPath, "utf8"),
  };
  const shader = await resolveShader({ entry: "/main.wgsl", modules, packageMap: { "@vgpu/wgsl-std/math": mathPath }, validate: false });

  const { device } = await App.create({ adapter: createNodeAdapter() });
  const gpu = device.gpu;
  const output = gpu.createBuffer({ size: outputSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const readback = gpu.createBuffer({ size: outputSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const pipeline = gpu.createComputePipeline({ layout: "auto", compute: { module: gpu.createShaderModule({ code: shader.wgsl }), entryPoint: "main" } });
    const bindGroup = gpu.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] });
    const encoder = gpu.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, outputSize);
    gpu.queue.submit([encoder.finish()]);
    await gpu.queue.onSubmittedWorkDone();
    await readback.mapAsync(GPUMapMode.READ);
    return new Float32Array(new Uint8Array(readback.getMappedRange()).slice().buffer);
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    readback.destroy();
    output.destroy();
    device.destroy();
  }
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
