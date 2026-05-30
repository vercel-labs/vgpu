import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

const dockerTest = process.env.VGPU_DOCKER_TEST === "1";

interface ScalarCase {
  readonly name: string;
  readonly actual: number;
  readonly expected: number;
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

describe("CPU reference color catalog", () => {
  test("sRGB transfer helpers match standard known values and round trips", () => {
    const scalarCases: readonly ScalarCase[] = [
      { name: "srgbToLinear black", actual: srgbToLinearRef(0), expected: 0 },
      { name: "srgbToLinear breakpoint", actual: srgbToLinearRef(0.04045), expected: 0.0031308049535603713 },
      { name: "srgbToLinear half", actual: srgbToLinearRef(0.5), expected: 0.21404114048223255 },
      { name: "srgbToLinear white", actual: srgbToLinearRef(1), expected: 1 },
      { name: "linearToSrgb black", actual: linearToSrgbRef(0), expected: 0 },
      { name: "linearToSrgb breakpoint", actual: linearToSrgbRef(0.0031308), expected: 0.040449936 },
      { name: "linearToSrgb half", actual: linearToSrgbRef(0.5), expected: 0.7353569830524495 },
      { name: "linearToSrgb white", actual: linearToSrgbRef(1), expected: 0.9999999999999999 },
      { name: "srgbToLinear is unclamped below range", actual: srgbToLinearRef(-0.5), expected: -0.5 / 12.92 },
      { name: "linearToSrgb is unclamped below range", actual: linearToSrgbRef(-0.01), expected: -0.1292 },
    ];

    for (const { name, actual, expected } of scalarCases) {
      expect.soft(actual, name).toBeCloseTo(expected, 8);
    }

    for (const value of [0, 0.0031308, 0.18, 0.5, 1]) {
      expect.soft(srgbToLinearRef(linearToSrgbRef(value)), `linear roundtrip ${value}`).toBeCloseTo(value, 6);
    }
    for (const value of [0, 0.04045, 0.25, 0.5, 1]) {
      expect.soft(linearToSrgbRef(srgbToLinearRef(value)), `srgb roundtrip ${value}`).toBeCloseTo(value, 6);
    }
  });

  test("vector sRGB helpers apply transfer functions per channel", () => {
    const vec3Cases: readonly Vec3Case[] = [
      { name: "srgbToLinear3", actual: srgbToLinear3Ref([0, 0.5, 1]), expected: [0, 0.21404114048223255, 1] },
      { name: "linearToSrgb3", actual: linearToSrgb3Ref([0, 0.18, 1]), expected: [0, 0.46135612950044164, 0.9999999999999999] },
    ];
    const vec4Cases: readonly Vec4Case[] = [
      { name: "srgbToLinear4 preserves alpha", actual: srgbToLinear4Ref([0, 0.5, 1, 0.25]), expected: [0, 0.21404114048223255, 1, 0.25] },
      { name: "linearToSrgb4 preserves alpha", actual: linearToSrgb4Ref([0, 0.18, 1, 0.25]), expected: [0, 0.46135612950044164, 0.9999999999999999, 0.25] },
    ];

    for (const { name, actual, expected } of vec3Cases) {
      expectVec3Close(actual, expected, name);
    }
    for (const { name, actual, expected } of vec4Cases) {
      expectVec4Close(actual, expected, name);
    }
  });

  test("luminance and exposure helpers use documented color-space conventions", () => {
    const cases: readonly ScalarCase[] = [
      { name: "luminance red", actual: luminanceRef([1, 0, 0]), expected: 0.2126 },
      { name: "luminance green", actual: luminanceRef([0, 1, 0]), expected: 0.7152 },
      { name: "luminance blue", actual: luminanceRef([0, 0, 1]), expected: 0.0722 },
      { name: "luminance white", actual: luminanceRef([1, 1, 1]), expected: 1 },
    ];
    for (const { name, actual, expected } of cases) {
      expect.soft(actual, name).toBeCloseTo(expected, 6);
    }

    expectVec3Close(applyExposureRef([0.18, 0.5, 1], 0), [0.18, 0.5, 1], "exposure zero");
    expectVec3Close(applyExposureRef([0.18, 0.5, 1], 1), [0.36, 1, 2], "exposure +1 stop");
    expectVec3Close(applyExposureRef([0.18, 0.5, 1], -2), [0.045, 0.125, 0.25], "exposure -2 stops");
  });
});

test("color helpers resolve from @vgpu/wgsl-std/color and produce valid declarations", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { srgbToLinear, srgbToLinear3, srgbToLinear4, linearToSrgb, linearToSrgb3, linearToSrgb4, luminance, applyExposure } from "@vgpu/wgsl-std/color";
fn main() -> vec4f {
  let c = srgbToLinear3(vec3f(0.5, 0.25, 1.0));
  let a = srgbToLinear4(vec4f(0.5, 0.25, 1.0, 0.75)).a;
  let encoded = linearToSrgb3(applyExposure(c, 1.0));
  let scalar = srgbToLinear(0.5) + linearToSrgb(0.18) + luminance(c) + linearToSrgb4(vec4f(c, a)).a;
  return vec4f(encoded, scalar);
}`);

  const result = await resolveShader({ entry, validate: false });

  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/color/index.wgsl"))).toBe(true);
  for (const name of ["srgbToLinear", "srgbToLinear3", "srgbToLinear4", "linearToSrgb", "linearToSrgb3", "linearToSrgb4", "luminance", "applyExposure"]) {
    expect.soft(result.wgsl, name).toMatch(new RegExp(`fn _vgsl_[0-9a-f]{8}__${name}\\(`, "u"));
  }
  expect(result.wgsl).not.toContain("identityVec3f");
});

test("single color helper import resolves deterministically", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { luminance } from "@vgpu/wgsl-std/color";
fn main() -> f32 {
  return luminance(vec3f(1.0, 1.0, 1.0));
}`);

  const first = await resolveShader({ entry, validate: false, minify: true });
  const second = await resolveShader({ entry, validate: false, minify: true });

  expect(first.wgsl).toBe(second.wgsl);
  expect(first.wgsl).toContain("dot(");
  expect(first.wgsl).not.toContain("\n");
  expect(first.wgsl).not.toContain("//");
});

test("color helper minified output is deterministic", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { srgbToLinear3, luminance } from "@vgpu/wgsl-std/color";
fn main() -> f32 {
  return luminance(srgbToLinear3(vec3f(0.5, 0.25, 1.0)));
}`);

  const first = await resolveShader({ entry, validate: false, minify: true });
  const second = await resolveShader({ entry, validate: false, minify: true });

  expect(first.wgsl).toBe(second.wgsl);
  expect(first.wgsl).not.toContain("\n");
  expect(first.wgsl).not.toContain("//");
  expect(first.wgsl).toContain("pow(");
  expect(first.wgsl).toContain("dot(");
});

test.skipIf(!dockerTest)("resolved color utility shader validates with naga", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { srgbToLinear3, linearToSrgb3, luminance, applyExposure } from "@vgpu/wgsl-std/color";
@compute @workgroup_size(1)
fn main() {
  let linear = srgbToLinear3(vec3f(0.5, 0.25, 1.0));
  let exposed = applyExposure(linear, 1.0);
  let encoded = linearToSrgb3(exposed);
  let value = luminance(encoded);
}`);

  await expect(resolveShader({ entry })).resolves.toHaveProperty("wgsl");
});

function srgbToLinearRef(value: number): number {
  if (value <= 0.04045) return value / 12.92;
  return Math.pow((value + 0.055) / 1.055, 2.4);
}

function linearToSrgbRef(value: number): number {
  if (value <= 0.0031308) return value * 12.92;
  return 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function srgbToLinear3Ref(value: readonly [number, number, number]): [number, number, number] {
  return [srgbToLinearRef(value[0]), srgbToLinearRef(value[1]), srgbToLinearRef(value[2])];
}

function srgbToLinear4Ref(value: readonly [number, number, number, number]): [number, number, number, number] {
  return [srgbToLinearRef(value[0]), srgbToLinearRef(value[1]), srgbToLinearRef(value[2]), value[3]];
}

function linearToSrgb3Ref(value: readonly [number, number, number]): [number, number, number] {
  return [linearToSrgbRef(value[0]), linearToSrgbRef(value[1]), linearToSrgbRef(value[2])];
}

function linearToSrgb4Ref(value: readonly [number, number, number, number]): [number, number, number, number] {
  return [linearToSrgbRef(value[0]), linearToSrgbRef(value[1]), linearToSrgbRef(value[2]), value[3]];
}

function luminanceRef(value: readonly [number, number, number]): number {
  return value[0] * 0.2126 + value[1] * 0.7152 + value[2] * 0.0722;
}

function applyExposureRef(value: readonly [number, number, number], exposure: number): [number, number, number] {
  const scale = Math.pow(2, exposure);
  return [value[0] * scale, value[1] * scale, value[2] * scale];
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
