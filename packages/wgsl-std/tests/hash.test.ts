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

interface Vec2uCase {
  readonly name: string;
  readonly actual: readonly [number, number];
  readonly expected: readonly [number, number];
}

interface Vec3uCase {
  readonly name: string;
  readonly actual: readonly [number, number, number];
  readonly expected: readonly [number, number, number];
}

describe("CPU reference hash catalog", () => {
  test("hashU32 implements Wellons lowbias32 constants", () => {
    const cases: readonly ScalarCase[] = [
      { name: "zero", actual: hashU32Ref(0), expected: 0 },
      { name: "one", actual: hashU32Ref(1), expected: 1753845952 },
      { name: "eve constant", actual: hashU32Ref(0x12345678), expected: 4125564054 },
      { name: "max", actual: hashU32Ref(0xffffffff), expected: 1734902346 },
    ];

    for (const { name, actual, expected } of cases) {
      expect.soft(actual, name).toBe(expected);
    }
  });

  test("pcg2d and pcg3d produce decorrelated vector hash outputs", () => {
    const vec2Cases: readonly Vec2uCase[] = [
      { name: "pcg2d zero", actual: pcg2dRef([0, 0]), expected: [417608103, 90043601] },
      { name: "pcg2d lattice", actual: pcg2dRef([12, 34]), expected: [2014198264, 1804320464] },
      { name: "pcg2d signed bitcast", actual: pcg2dRef([0xffffffff, 2]), expected: [69867811, 3975126717] },
    ];
    const vec3Cases: readonly Vec3uCase[] = [
      { name: "pcg3d zero", actual: pcg3dRef([0, 0, 0]), expected: [2611956841, 2833785475, 1058371385] },
      { name: "pcg3d lattice", actual: pcg3dRef([12, 34, 56]), expected: [2329867099, 1935890346, 3960488285] },
      { name: "pcg3d signed bitcast", actual: pcg3dRef([0xffffffff, 2, 0xfffffffd]), expected: [2548054097, 4228783117, 1087715006] },
    ];

    for (const { name, actual, expected } of vec2Cases) expectVec2u(actual, expected, name);
    for (const { name, actual, expected } of vec3Cases) expectVec3u(actual, expected, name);
  });

  test("unitFloat maps u32 values into [0, 1) with 24-bit precision", () => {
    const cases: readonly ScalarCase[] = [
      { name: "zero", actual: unitFloatRef(0), expected: 0 },
      { name: "one after shift", actual: unitFloatRef(0x00000100), expected: 1 / 16777216 },
      { name: "drops low bits", actual: unitFloatRef(0x000001ff), expected: 1 / 16777216 },
      { name: "max below one", actual: unitFloatRef(0xffffffff), expected: 0.9999999403953552 },
    ];

    for (const { name, actual, expected } of cases) {
      expect.soft(actual, name).toBeCloseTo(expected, 12);
      expect.soft(actual, `${name} range`).toBeLessThan(1);
    }
  });

  test("float wrappers bitcast seeds before hashing", () => {
    expect(hash1Ref(0)).toBe(0);
    expect(hash1Ref(-0)).not.toBe(hash1Ref(0));
    expect(hash1Ref(1)).toBeCloseTo(0.8841683268547058, 12);
    expectVec2Close(hash2Ref([0.25, -0.5]), [0.5884251594543457, 0.24299609661102295], "hash2");
    expectVec3Close(hash3Ref([0.25, -0.5, 8]), [0.6727914810180664, 0.2099326252937317, 0.4681243896484375], "hash3");
  });
});

test("hash helpers resolve from @vgpu/wgsl-std/hash and produce valid declarations", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { hashU32, pcg2d, pcg3d, unitFloat, hash1, hash2, hash3 } from "@vgpu/wgsl-std/hash";
fn main() -> vec4f {
  let a = hashU32(1u);
  let b = pcg2d(vec2u(1u, 2u));
  let c = pcg3d(vec3u(1u, 2u, 3u));
  let d = hash2(vec2f(hash1(1.0), unitFloat(a)));
  return vec4f(d, hash3(vec3f(f32(b.x), f32(c.y), 1.0)).z, unitFloat(c.z));
}`);

  const result = await resolveShader({ entry, validate: false });

  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/hash/index.wgsl"))).toBe(true);
  for (const name of ["hashU32", "pcg2d", "pcg3d", "unitFloat", "hash1", "hash2", "hash3"]) {
    expect.soft(result.wgsl, name).toMatch(new RegExp(`fn _vgsl_[0-9a-f]{8}__${name}\\(`, "u"));
  }
});

test("hash helper minified output is deterministic", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { hash3 } from "@vgpu/wgsl-std/hash";
fn main() -> vec3f {
  return hash3(vec3f(1.0, 2.0, 3.0));
}`);

  const first = await resolveShader({ entry, validate: false, minify: true });
  const second = await resolveShader({ entry, validate: false, minify: true });

  expect(first.wgsl).toBe(second.wgsl);
  expect(first.wgsl).not.toContain("\n");
  expect(first.wgsl).not.toContain("//");
  expect(first.wgsl).toContain("bitcast<vec3u>");
  expect(first.wgsl).toContain("16777216.0");
});

test.skipIf(!dockerTest)("resolved hash utility shader validates with naga", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { hashU32, pcg2d, pcg3d, unitFloat, hash1, hash2, hash3 } from "@vgpu/wgsl-std/hash";
@compute @workgroup_size(1)
fn main() {
  let value = unitFloat(hashU32(1u)) + hash1(1.0) + hash2(vec2f(1.0)).x + hash3(vec3f(1.0)).z;
  let lattice = pcg2d(vec2u(1u, 2u)).x + pcg3d(vec3u(1u, 2u, 3u)).y;
}`);

  await expect(resolveShader({ entry })).resolves.toHaveProperty("wgsl");
});

function hashU32Ref(value: number): number {
  let hashed = value >>> 0;
  hashed = Math.imul(hashed ^ (hashed >>> 16), 0x7feb352d) >>> 0;
  hashed = Math.imul(hashed ^ (hashed >>> 15), 0x846ca68b) >>> 0;
  return (hashed ^ (hashed >>> 16)) >>> 0;
}

function pcg2dRef(value: readonly [number, number]): [number, number] {
  let x = (Math.imul(value[0], 1664525) + 1013904223) >>> 0;
  let y = (Math.imul(value[1], 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, 1664525)) >>> 0;
  y = (y + Math.imul(x, 1664525)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  x = (x + Math.imul(y, 1664525)) >>> 0;
  y = (y + Math.imul(x, 1664525)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  return [x, y];
}

function pcg3dRef(value: readonly [number, number, number]): [number, number, number] {
  let x = (Math.imul(value[0], 1664525) + 1013904223) >>> 0;
  let y = (Math.imul(value[1], 1664525) + 1013904223) >>> 0;
  let z = (Math.imul(value[2], 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  return [x, y, z];
}

function unitFloatRef(hash: number): number {
  return (hash >>> 8) * (1 / 16777216);
}

function hash1Ref(seed: number): number {
  return unitFloatRef(hashU32Ref(floatBits(seed)));
}

function hash2Ref(seed: readonly [number, number]): [number, number] {
  const hashed = pcg2dRef([floatBits(seed[0]), floatBits(seed[1])]);
  return [unitFloatRef(hashed[0]), unitFloatRef(hashed[1])];
}

function hash3Ref(seed: readonly [number, number, number]): [number, number, number] {
  const hashed = pcg3dRef([floatBits(seed[0]), floatBits(seed[1]), floatBits(seed[2])]);
  return [unitFloatRef(hashed[0]), unitFloatRef(hashed[1]), unitFloatRef(hashed[2])];
}

function floatBits(value: number): number {
  const data = new DataView(new ArrayBuffer(4));
  data.setFloat32(0, value, true);
  return data.getUint32(0, true);
}

function expectVec2u(actual: readonly [number, number], expected: readonly [number, number], name: string): void {
  expect.soft(actual[0], `${name}.x`).toBe(expected[0]);
  expect.soft(actual[1], `${name}.y`).toBe(expected[1]);
}

function expectVec3u(actual: readonly [number, number, number], expected: readonly [number, number, number], name: string): void {
  expect.soft(actual[0], `${name}.x`).toBe(expected[0]);
  expect.soft(actual[1], `${name}.y`).toBe(expected[1]);
  expect.soft(actual[2], `${name}.z`).toBe(expected[2]);
}

function expectVec2Close(actual: readonly [number, number], expected: readonly [number, number], name: string): void {
  expect.soft(actual[0], `${name}.x`).toBeCloseTo(expected[0], 12);
  expect.soft(actual[1], `${name}.y`).toBeCloseTo(expected[1], 12);
}

function expectVec3Close(actual: readonly [number, number, number], expected: readonly [number, number, number], name: string): void {
  expect.soft(actual[0], `${name}.x`).toBeCloseTo(expected[0], 12);
  expect.soft(actual[1], `${name}.y`).toBeCloseTo(expected[1], 12);
  expect.soft(actual[2], `${name}.z`).toBeCloseTo(expected[2], 12);
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
