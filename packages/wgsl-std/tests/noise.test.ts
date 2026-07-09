import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

const dockerTest = process.env.VGPU_DOCKER_TEST === "1";

interface Voronoi2Case {
  readonly name: string;
  readonly actual: VoronoiSample2;
  readonly expected: VoronoiSample2;
}

interface Voronoi3Case {
  readonly name: string;
  readonly actual: VoronoiSample3;
  readonly expected: VoronoiSample3;
}

interface VoronoiSample2 {
  readonly f1: number;
  readonly f2: number;
  readonly cell: readonly [number, number];
}

interface VoronoiSample3 {
  readonly f1: number;
  readonly f2: number;
  readonly cell: readonly [number, number, number];
}

describe("CPU reference noise catalog", () => {
  test("voronoi2d returns F1/F2 distances and winning integer cell", () => {
    const cases: readonly Voronoi2Case[] = [
      { name: "inside origin", actual: voronoi2dRef([0.25, 0.75]), expected: { f1: 0.3116547450682862, f2: 0.6680907494963148, cell: [-1, 0] } },
      { name: "crosses negative cells", actual: voronoi2dRef([-0.2, 1.4]), expected: { f1: 0.19698809183334964, f2: 0.822784004769412, cell: [-1, 1] } },
      { name: "positive lattice", actual: voronoi2dRef([12.25, 34.75]), expected: { f1: 0.39595438569499203, f2: 0.42532746615482253, cell: [12, 34] } },
    ];

    for (const { name, actual, expected } of cases) expectVoronoi2(actual, expected, name);
  });

  test("voronoi3d returns F1/F2 distances and winning integer cell", () => {
    const cases: readonly Voronoi3Case[] = [
      { name: "inside origin", actual: voronoi3dRef([0.25, 0.75, 0.5]), expected: { f1: 0.4480027402212402, f2: 0.5783371011214562, cell: [0, 0, 0] } },
      { name: "animated z slice", actual: voronoi3dRef([4.2, -1.25, 8.5]), expected: { f1: 0.23850126667146912, f2: 0.6421127391636843, cell: [4, -2, 8] } },
      { name: "neighbor winner", actual: voronoi3dRef([12.25, 34.75, 56.5]), expected: { f1: 0.5943762206456527, f2: 0.6393953677971502, cell: [12, 34, 56] } },
    ];

    for (const { name, actual, expected } of cases) expectVoronoi3(actual, expected, name);
  });
});

test("noise helpers resolve from @vgpu/wgsl-std/noise and produce valid declarations", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { VoronoiSample2, VoronoiSample3, voronoi2d, voronoi3d } from "@vgpu/wgsl-std/noise";
fn main() -> vec4f {
  let a: VoronoiSample2 = voronoi2d(vec2f(0.25, 0.75));
  let b: VoronoiSample3 = voronoi3d(vec3f(a.f1, a.f2, 0.5));
  return vec4f(a.f1, a.f2, b.f1, f32(b.cell.z));
}`);

  const result = await resolveShader({ entry, validate: false });

  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/noise/index.wgsl"))).toBe(true);
  expect(result.deps.some((dep) => dep.endsWith("node_modules/@vgpu/wgsl-std/src/hash/index.wgsl"))).toBe(true);
  for (const name of ["VoronoiSample2", "VoronoiSample3", "voronoi2d", "voronoi3d"]) {
    expect.soft(result.wgsl, name).toMatch(new RegExp(`_vgsl_[0-9a-f]{8}__${name}`, "u"));
  }
});

test("noise helper minified output is deterministic", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { voronoi3d } from "@vgpu/wgsl-std/noise";
fn main() -> f32 {
  let v = voronoi3d(vec3f(1.0, 2.0, 3.0));
  return v.f2 - v.f1;
}`);

  const first = await resolveShader({ entry, validate: false, minify: true });
  const second = await resolveShader({ entry, validate: false, minify: true });

  expect(first.wgsl).toBe(second.wgsl);
  expect(first.wgsl).not.toContain("\n");
  expect(first.wgsl).not.toContain("//");
  expect(first.wgsl).toContain("for(var");
  expect(first.wgsl).toContain("length(");
});

test.skipIf(!dockerTest)("resolved noise utility shader validates with naga", async () => {
  const dir = await workspaceFixture();
  const entry = join(dir, "app", "main.wgsl");
  await writeFile(entry, `import { voronoi2d, voronoi3d } from "@vgpu/wgsl-std/noise";
@compute @workgroup_size(1)
fn main() {
  let a = voronoi2d(vec2f(0.25, 0.75));
  let b = voronoi3d(vec3f(a.f1, a.f2, 0.5));
  let edge = b.f2 - b.f1;
}`);

  await expect(resolveShader({ entry })).resolves.toHaveProperty("wgsl");
});

function voronoi2dRef(position: readonly [number, number]): VoronoiSample2 {
  const baseCell: [number, number] = [Math.floor(position[0]), Math.floor(position[1])];
  let f1 = Number.POSITIVE_INFINITY;
  let f2 = Number.POSITIVE_INFINITY;
  let winner: [number, number] = [...baseCell];

  for (let y = -1; y <= 1; y += 1) {
    for (let x = -1; x <= 1; x += 1) {
      const cell: [number, number] = [baseCell[0] + x, baseCell[1] + y];
      const hashed = pcg2dRef([cell[0] >>> 0, cell[1] >>> 0]);
      const feature: [number, number] = [cell[0] + unitFloatRef(hashed[0]), cell[1] + unitFloatRef(hashed[1])];
      const distance = Math.hypot(feature[0] - position[0], feature[1] - position[1]);
      if (distance < f1) {
        f2 = f1;
        f1 = distance;
        winner = cell;
      } else if (distance < f2) {
        f2 = distance;
      }
    }
  }
  return { f1, f2, cell: winner };
}

function voronoi3dRef(position: readonly [number, number, number]): VoronoiSample3 {
  const baseCell: [number, number, number] = [Math.floor(position[0]), Math.floor(position[1]), Math.floor(position[2])];
  let f1 = Number.POSITIVE_INFINITY;
  let f2 = Number.POSITIVE_INFINITY;
  let winner: [number, number, number] = [...baseCell];

  for (let z = -1; z <= 1; z += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let x = -1; x <= 1; x += 1) {
        const cell: [number, number, number] = [baseCell[0] + x, baseCell[1] + y, baseCell[2] + z];
        const hashed = pcg3dRef([cell[0] >>> 0, cell[1] >>> 0, cell[2] >>> 0]);
        const feature: [number, number, number] = [cell[0] + unitFloatRef(hashed[0]), cell[1] + unitFloatRef(hashed[1]), cell[2] + unitFloatRef(hashed[2])];
        const distance = Math.hypot(feature[0] - position[0], feature[1] - position[1], feature[2] - position[2]);
        if (distance < f1) {
          f2 = f1;
          f1 = distance;
          winner = cell;
        } else if (distance < f2) {
          f2 = distance;
        }
      }
    }
  }
  return { f1, f2, cell: winner };
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

function expectVoronoi2(actual: VoronoiSample2, expected: VoronoiSample2, name: string): void {
  expect.soft(actual.f1, `${name}.f1`).toBeCloseTo(expected.f1, 12);
  expect.soft(actual.f2, `${name}.f2`).toBeCloseTo(expected.f2, 12);
  expect.soft(actual.f1, `${name}.ordered`).toBeLessThanOrEqual(actual.f2);
  expect.soft(actual.cell, `${name}.cell`).toEqual(expected.cell);
}

function expectVoronoi3(actual: VoronoiSample3, expected: VoronoiSample3, name: string): void {
  expect.soft(actual.f1, `${name}.f1`).toBeCloseTo(expected.f1, 12);
  expect.soft(actual.f2, `${name}.f2`).toBeCloseTo(expected.f2, 12);
  expect.soft(actual.f1, `${name}.ordered`).toBeLessThanOrEqual(actual.f2);
  expect.soft(actual.cell, `${name}.cell`).toEqual(expected.cell);
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
