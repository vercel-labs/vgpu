import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

const dockerTest = process.env.VGPU_DOCKER_TEST === "1";
const goldenAngleRef = 2.399963229728653;

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

describe("CPU reference sampling catalog", () => {
  test("vogelDisk matches known unit-disk positions", () => {
    const cases: readonly Vec2Case[] = [
      { name: "index 0", actual: vogelDiskRef(0, 8, 0), expected: [0.25, 0] },
      { name: "index 1", actual: vogelDiskRef(1, 8, 0), expected: [-0.319290090188, 0.29249587742] },
      { name: "index 2", actual: vogelDiskRef(2, 8, 0), expected: [0.048872465862, -0.556876541148] },
      { name: "index 3", actual: vogelDiskRef(3, 8, 0), expected: [0.402444478534, 0.524917557048] },
      { name: "index 4", actual: vogelDiskRef(4, 8, 0), expected: [-0.738535113987, -0.130636462784] },
      { name: "phi offset", actual: vogelDiskRef(2, 8, 0.75), expected: [0.41534807426, -0.374146999465] },
    ];

    for (const { name, actual, expected } of cases) {
      expectVec2Close(actual, expected, name, 9);
    }
  });

  test("vogelDisk radii stay bounded and monotonic for index < count", () => {
    let previousRadius = 0;
    for (let index = 0; index < 32; index += 1) {
      const point = vogelDiskRef(index, 32, 0.25);
      const radius = Math.hypot(point[0], point[1]);
      expect.soft(radius, `radius ${index}`).toBeLessThanOrEqual(1);
      expect.soft(radius, `monotonic ${index}`).toBeGreaterThanOrEqual(previousRadius);
      previousRadius = radius;
    }
  });

  test("vogelDisk angle advances by the golden angle and applies phi as rotation", () => {
    const phi = 0.375;
    for (let index = 0; index < 8; index += 1) {
      const current = normalizedAngle(vogelAngleRef(index, phi));
      const next = normalizedAngle(vogelAngleRef(index + 1, phi));
      expect.soft(normalizedAngle(next - current), `increment ${index}`).toBeCloseTo(normalizedAngle(goldenAngleRef), 12);
    }

    const withoutPhi = Math.atan2(vogelDiskRef(3, 16, 0)[1], vogelDiskRef(3, 16, 0)[0]);
    const withPhi = Math.atan2(vogelDiskRef(3, 16, phi)[1], vogelDiskRef(3, 16, phi)[0]);
    expect(normalizedAngle(withPhi - withoutPhi)).toBeCloseTo(phi, 12);
  });

  test("vogelDisk returns origin for count 0 to avoid division by zero", () => {
    expectVec2Close(vogelDiskRef(7, 0, 1.25), [0, 0], "count zero");
  });

  test("radicalInverseVdc produces standard base-2 Van der Corput values", () => {
    const cases: readonly ScalarCase[] = [
      { name: "0", actual: radicalInverseVdcRef(0), expected: 0 },
      { name: "1", actual: radicalInverseVdcRef(1), expected: 0.5 },
      { name: "2", actual: radicalInverseVdcRef(2), expected: 0.25 },
      { name: "3", actual: radicalInverseVdcRef(3), expected: 0.75 },
      { name: "4", actual: radicalInverseVdcRef(4), expected: 0.125 },
      { name: "5", actual: radicalInverseVdcRef(5), expected: 0.625 },
      { name: "6", actual: radicalInverseVdcRef(6), expected: 0.375 },
      { name: "7", actual: radicalInverseVdcRef(7), expected: 0.875 },
      { name: "high reversed value clamps to largest f32 below 1", actual: radicalInverseVdcRef(0x0fffffff), expected: 0.99999994 },
      { name: "max clamps to largest f32 below 1", actual: radicalInverseVdcRef(0xffffffff), expected: 0.99999994 },
      { name: "near-max input follows bit reversal", actual: radicalInverseVdcRef(0xfffffff0), expected: 0.062499999767169356 },
    ];

    for (const { name, actual, expected } of cases) {
      expect.soft(actual, name).toBeCloseTo(expected, 12);
    }
  });

  test("hammersley2d combines linear x with Van der Corput y and handles count 0", () => {
    const cases: readonly Vec2Case[] = [
      { name: "index 0", actual: hammersley2dRef(0, 8), expected: [0, 0] },
      { name: "index 1", actual: hammersley2dRef(1, 8), expected: [0.125, 0.5] },
      { name: "index 2", actual: hammersley2dRef(2, 8), expected: [0.25, 0.25] },
      { name: "index 3", actual: hammersley2dRef(3, 8), expected: [0.375, 0.75] },
      { name: "index 4", actual: hammersley2dRef(4, 8), expected: [0.5, 0.125] },
      { name: "count zero", actual: hammersley2dRef(4, 0), expected: [0, 0] },
    ];

    for (const { name, actual, expected } of cases) {
      expectVec2Close(actual, expected, name);
    }
  });
});

test("sampling helpers resolve from @vgpu/wgsl-std/sampling and produce valid declarations", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { goldenAngle, vogelDisk, radicalInverseVdc, hammersley2d } from "@vgpu/wgsl-std/sampling";
fn main() -> vec4f {
  let disk = vogelDisk(3u, 16u, goldenAngle);
  let sample = hammersley2d(3u, 16u);
  return vec4f(disk, sample.x, radicalInverseVdc(3u) + sample.y);
}`);

  const result = await resolveShader({ entry, validate: false });

  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/sampling/index.wgsl"))).toBe(true);
  expect(result.wgsl).toMatch(/const _vgsl_[0-9a-f]{8}__goldenAngle/u);
  for (const name of ["vogelDisk", "radicalInverseVdc", "hammersley2d"]) {
    expect.soft(result.wgsl, name).toMatch(new RegExp(`fn _vgsl_[0-9a-f]{8}__${name}\\(`, "u"));
  }
});

test("sampling helper minified output is deterministic", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { hammersley2d } from "@vgpu/wgsl-std/sampling";
fn main() -> vec2f {
  return hammersley2d(5u, 16u);
}`);

  const first = await resolveShader({ entry, validate: false, minify: true });
  const second = await resolveShader({ entry, validate: false, minify: true });

  expect(first.wgsl).toBe(second.wgsl);
  expect(first.wgsl).not.toContain("\n");
  expect(first.wgsl).not.toContain("//");
  expect(first.wgsl).toContain("&0x55555555u");
  expect(first.wgsl).toContain("return vec2f(");
});

test.skipIf(!dockerTest)("resolved sampling utility shader validates with naga", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { goldenAngle, vogelDisk, radicalInverseVdc, hammersley2d } from "@vgpu/wgsl-std/sampling";
@compute @workgroup_size(1)
fn main() {
  let disk = vogelDisk(3u, 16u, goldenAngle);
  let sample = hammersley2d(3u, 16u);
  let value = disk.x + disk.y + sample.x + sample.y + radicalInverseVdc(3u);
}`);

  await expect(resolveShader({ entry })).resolves.toHaveProperty("wgsl");
});

function vogelDiskRef(index: number, count: number, phi: number): [number, number] {
  if (count === 0) return [0, 0];
  const angle = vogelAngleRef(index, phi);
  const radius = Math.sqrt((index + 0.5) / count);
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

function vogelAngleRef(index: number, phi: number): number {
  return index * goldenAngleRef + phi;
}

function radicalInverseVdcRef(bits: number): number {
  let value = bits >>> 0;
  value = ((value << 16) | (value >>> 16)) >>> 0;
  value = (((value & 0x55555555) << 1) | ((value & 0xaaaaaaaa) >>> 1)) >>> 0;
  value = (((value & 0x33333333) << 2) | ((value & 0xcccccccc) >>> 2)) >>> 0;
  value = (((value & 0x0f0f0f0f) << 4) | ((value & 0xf0f0f0f0) >>> 4)) >>> 0;
  value = (((value & 0x00ff00ff) << 8) | ((value & 0xff00ff00) >>> 8)) >>> 0;
  return Math.min(value * 2.3283064365386963e-10, 0.99999994);
}

function hammersley2dRef(index: number, count: number): [number, number] {
  if (count === 0) return [0, 0];
  return [index / count, radicalInverseVdcRef(index)];
}

function normalizedAngle(angle: number): number {
  const tau = Math.PI * 2;
  return ((angle % tau) + tau) % tau;
}

function expectVec2Close(actual: readonly [number, number], expected: readonly [number, number], name: string, precision = 6): void {
  expect.soft(actual[0], `${name}.x`).toBeCloseTo(expected[0], precision);
  expect.soft(actual[1], `${name}.y`).toBeCloseTo(expected[1], precision);
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
