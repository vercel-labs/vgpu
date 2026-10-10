import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { describe, expect, test } from "vitest";
import { runNoiseCompute } from "./support/gpu-compute.ts";

type Vec3 = readonly [number, number, number];
type Mat4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

const dockerTest = process.env.VGPU_DOCKER_TEST === "1";
const sceneModulePath = resolve("packages/wgsl-std/src/scene/index.wgsl");
const scenePackageSubpath = "@vgpu/wgsl-std/scene";
const allHelpers = ["instanceWorldMatrix", "transformPosition", "transformDirection", "transformNormal"] as const;

describe("scene module resolution", () => {
  test("resolves all pure scene helpers through a virtual package map", async () => {
    const result = await resolveScene(`import { ${allHelpers.join(", ")} } from "${scenePackageSubpath}";
fn applyScene(world0: vec4f, world1: vec4f, world2: vec4f, world3: vec4f, value: vec3f) -> vec4f {
  let world = instanceWorldMatrix(world0, world1, world2, world3);
  let position = transformPosition(world, value);
  let direction = transformDirection(world, value);
  let normal = transformNormal(world, value);
  return vec4f(position + direction + normal, 1.0);
}`);

    expect(result.deps).toContain(sceneModulePath);
    expect(result.reflection.bindings).toEqual([]);
    expect(result.reflection.entryPoints).toEqual([]);
    for (const helper of allHelpers) {
      expect.soft(result.wgsl, helper).toMatch(new RegExp(`fn _vgsl_[0-9a-f]{8}__${helper}\\(`, "u"));
    }
  });

  test("prunes unused helpers from an entry point", async () => {
    const source = `import { transformPosition } from "${scenePackageSubpath}";
@vertex
fn main(@location(0) value: vec3f) -> @builtin(position) vec4f {
  let world = mat4x4f(
    vec4f(1.0, 0.0, 0.0, 0.0),
    vec4f(0.0, 1.0, 0.0, 0.0),
    vec4f(0.0, 0.0, 1.0, 0.0),
    vec4f(0.0, 0.0, 0.0, 1.0),
  );
  return vec4f(transformPosition(world, value), 1.0);
}`;
    const result = await resolveScene(source);

    expect(result.wgsl).toMatch(/fn _vgsl_[0-9a-f]{8}__transformPosition\(/u);
    expect(result.wgsl).not.toContain("__transformDirection");
    expect(result.wgsl).not.toContain("__transformNormal");
    expect(result.wgsl).not.toContain("__instanceWorldMatrix");
    expect(result.reflection.bindings).toEqual([]);
    expect(result.reflection.entryPoints.map((entryPoint) => entryPoint.name)).toEqual(["main"]);
  });

  test("minifies deterministically", async () => {
    const source = `import { transformPosition } from "${scenePackageSubpath}";
@vertex
fn main(@location(0) value: vec3f) -> @builtin(position) vec4f {
  let world = mat4x4f(
    vec4f(1.0, 0.0, 0.0, 0.0),
    vec4f(0.0, 1.0, 0.0, 0.0),
    vec4f(0.0, 0.0, 1.0, 0.0),
    vec4f(0.0, 0.0, 0.0, 1.0),
  );
  return vec4f(transformPosition(world, value), 1.0);
}`;
    const first = await resolveScene(source, true);
    const second = await resolveScene(source, true);

    expect(first.wgsl).toBe(second.wgsl);
    expect(first.wgsl).not.toContain("\n");
    expect(first.reflection.bindings).toEqual([]);
    expect(first.reflection.entryPoints.map((entryPoint) => entryPoint.name)).toEqual(["main"]);
  });
});

const normalCases: readonly { readonly name: string; readonly matrix: Mat4; readonly normal: Vec3; readonly tangent?: Vec3 }[] = [
  {
    name: "identity",
    matrix: matrixFromLinear([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]),
    normal: [1, 2, 3],
    tangent: [2, -1, 0],
  },
  {
    name: "rotation",
    matrix: matrixFromLinear([
      0, 1, 0,
      -1, 0, 0,
      0, 0, 1,
    ]),
    normal: [1, 0, 0],
    tangent: [0, 1, 0],
  },
  {
    name: "nonuniform scale",
    matrix: matrixFromLinear([
      2, 0, 0,
      0, 3, 0,
      0, 0, 4,
    ]),
    normal: [1, 1, 1],
    tangent: [1, -1, 0],
  },
  {
    name: "shear",
    matrix: matrixFromLinear([
      1, 0.25, 0,
      0.5, 1, 0.2,
      0, 0.4, 1.5,
    ]),
    normal: [1, -2, 1],
    tangent: [2, 1, 0],
  },
  {
    name: "reflection",
    matrix: matrixFromLinear([
      -2, 0, 0,
      0, 3, 0,
      0, 0, 4,
    ]),
    normal: [1, 2, 3],
    tangent: [2, -1, 0],
  },
  {
    name: "combined rotation, scale, and shear",
    matrix: matrixFromLinear([
      1.7320508075688772, 1, 0,
      -0.6339745962155612, 3.098076211353316, 0.75,
      0.2, 0.34641016151377546, 4,
    ]),
    normal: [2, -1, 3],
    tangent: [1, 2, 0],
  },
  {
    name: "small finite scale and normal",
    matrix: matrixFromLinear([
      1e-20, 0, 0,
      0, 1e-20, 0,
      0, 0, 1e-20,
    ]),
    normal: [1e-20, -2e-20, 3e-20],
    tangent: [2e-20, 1e-20, 0],
  },
];

test.skipIf(!dockerTest)("scene helpers match CPU transforms and inverse-transpose normals on a native GPU", async () => {
  const prefixLength = 6;
  const outputLength = prefixLength + (normalCases.length + 3) * 3;
  const body: string[] = [
    "  let world = instanceWorldMatrix(vec4f(2.0, 0.0, 0.0, 0.0), vec4f(0.0, 3.0, 0.0, 0.0), vec4f(0.0, 0.0, 4.0, 0.0), vec4f(5.0, 6.0, 7.0, 1.0));",
    "  let position = transformPosition(world, vec3f(1.0));",
    "  let direction = transformDirection(world, vec3f(1.0));",
    ...writeVec3("position", 0),
    ...writeVec3("direction", 3),
  ];

  normalCases.forEach((normalCase, index) => {
    const variable = `normal${index}`;
    body.push(`  let ${variable} = transformNormal(${wgslMat4(normalCase.matrix)}, ${wgslVec3(normalCase.normal)});`);
    body.push(...writeVec3(variable, prefixLength + index * 3));
  });

  const zeroOffset = prefixLength + normalCases.length * 3;
  body.push("  let zeroNormal = transformNormal(mat4x4f(vec4f(1.0, 0.0, 0.0, 0.0), vec4f(0.0, 1.0, 0.0, 0.0), vec4f(0.0, 0.0, 1.0, 0.0), vec4f(0.0, 0.0, 0.0, 1.0)), vec3f(0.0));");
  body.push(...writeVec3("zeroNormal", zeroOffset));
  body.push("  let singularNormal = transformNormal(mat4x4f(vec4f(1.0, 0.0, 0.0, 0.0), vec4f(0.0, 1.0, 0.0, 0.0), vec4f(0.0, 0.0, 0.0, 0.0), vec4f(0.0, 0.0, 0.0, 1.0)), vec3f(0.0, 0.0, 1.0));");
  body.push(...writeVec3("singularNormal", zeroOffset + 3));
  body.push("  let parallelColumnsNormal = transformNormal(mat4x4f(vec4f(0.25, 0.5, 1.0, 0.0), vec4f(0.5, 1.0, 2.0, 0.0), vec4f(0.0, 1.0, 0.0, 0.0), vec4f(0.0, 0.0, 0.0, 1.0)), vec3f(1.0));");
  body.push(...writeVec3("parallelColumnsNormal", zeroOffset + 6));

  const values = await runNoiseCompute({
    modulePackagePath: sceneModulePath,
    packageSubpath: scenePackageSubpath,
    imports: allHelpers,
    outputLength,
    computeBody: body.join("\n"),
  });

  expectVec3Close(values.slice(0, 3), [7, 9, 11], "translated position");
  expectVec3Close(values.slice(3, 6), [2, 3, 4], "direction ignores translation and preserves scale");
  expect(length3(values.slice(3, 6))).toBeCloseTo(Math.sqrt(29), 5);

  normalCases.forEach((normalCase, index) => {
    const offset = prefixLength + index * 3;
    const actual = values.slice(offset, offset + 3);
    const expected = inverseTransposeNormal(normalCase.matrix, normalCase.normal);
    expectVec3Close(actual, expected, normalCase.name);
    expect(length3(actual), normalCase.name).toBeCloseTo(1, 5);
    if (normalCase.tangent) {
      const transformedTangent = transformDirectionRef(normalCase.matrix, normalCase.tangent);
      expect(dot3(actual, transformedTangent), `${normalCase.name} tangent orthogonality`).toBeCloseTo(0, 4);
    }
  });

  expect(determinant3(normalCases[3]!.matrix)).toBeGreaterThan(0);
  expect(determinant3(normalCases[4]!.matrix)).toBeLessThan(0);
  expect([...values.slice(zeroOffset, zeroOffset + 9)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (const value of values) expect.soft(Number.isFinite(value)).toBe(true);
});

async function resolveScene(source: string, minify = false) {
  return resolveShader({
    entry: "/main.wgsl",
    modules: {
      "/main.wgsl": source,
      [sceneModulePath]: await readFile(sceneModulePath, "utf8"),
    },
    packageMap: { [scenePackageSubpath]: sceneModulePath },
    validate: false,
    minify,
  });
}

function matrixFromLinear(linear: readonly number[]): Mat4 {
  return [
    linear[0]!, linear[1]!, linear[2]!, 0,
    linear[3]!, linear[4]!, linear[5]!, 0,
    linear[6]!, linear[7]!, linear[8]!, 0,
    0, 0, 0, 1,
  ];
}

function inverseTransposeNormal(matrix: Mat4, normal: Vec3): Vec3 {
  const a00 = matrix[0];
  const a01 = matrix[4];
  const a02 = matrix[8];
  const a10 = matrix[1];
  const a11 = matrix[5];
  const a12 = matrix[9];
  const a20 = matrix[2];
  const a21 = matrix[6];
  const a22 = matrix[10];
  const determinant = a00 * (a11 * a22 - a12 * a21)
    - a01 * (a10 * a22 - a12 * a20)
    + a02 * (a10 * a21 - a11 * a20);
  if (determinant === 0 || dot3(normal, normal) === 0) return [0, 0, 0];

  const inverse = [
    (a11 * a22 - a12 * a21) / determinant,
    (a02 * a21 - a01 * a22) / determinant,
    (a01 * a12 - a02 * a11) / determinant,
    (a12 * a20 - a10 * a22) / determinant,
    (a00 * a22 - a02 * a20) / determinant,
    (a02 * a10 - a00 * a12) / determinant,
    (a10 * a21 - a11 * a20) / determinant,
    (a01 * a20 - a00 * a21) / determinant,
    (a00 * a11 - a01 * a10) / determinant,
  ] as const;
  return normalize3([
    inverse[0] * normal[0] + inverse[3] * normal[1] + inverse[6] * normal[2],
    inverse[1] * normal[0] + inverse[4] * normal[1] + inverse[7] * normal[2],
    inverse[2] * normal[0] + inverse[5] * normal[1] + inverse[8] * normal[2],
  ]);
}

function determinant3(matrix: Mat4): number {
  const a00 = matrix[0];
  const a01 = matrix[4];
  const a02 = matrix[8];
  const a10 = matrix[1];
  const a11 = matrix[5];
  const a12 = matrix[9];
  const a20 = matrix[2];
  const a21 = matrix[6];
  const a22 = matrix[10];
  return a00 * (a11 * a22 - a12 * a21)
    - a01 * (a10 * a22 - a12 * a20)
    + a02 * (a10 * a21 - a11 * a20);
}

function transformDirectionRef(matrix: Mat4, direction: Vec3): Vec3 {
  return [
    matrix[0] * direction[0] + matrix[4] * direction[1] + matrix[8] * direction[2],
    matrix[1] * direction[0] + matrix[5] * direction[1] + matrix[9] * direction[2],
    matrix[2] * direction[0] + matrix[6] * direction[1] + matrix[10] * direction[2],
  ];
}

function normalize3(value: Vec3): Vec3 {
  const length = length3(value);
  if (length === 0) return [0, 0, 0];
  return [value[0] / length, value[1] / length, value[2] / length];
}

function length3(value: ArrayLike<number>): number {
  return Math.sqrt(dot3(value, value));
}

function dot3(left: ArrayLike<number>, right: ArrayLike<number>): number {
  return left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;
}

function expectVec3Close(actual: ArrayLike<number>, expected: Vec3, name: string): void {
  expect.soft(actual[0], `${name}.x`).toBeCloseTo(expected[0], 5);
  expect.soft(actual[1], `${name}.y`).toBeCloseTo(expected[1], 5);
  expect.soft(actual[2], `${name}.z`).toBeCloseTo(expected[2], 5);
}

function wgslMat4(matrix: Mat4): string {
  const columns = [0, 4, 8, 12].map((offset) => `vec4f(${matrix.slice(offset, offset + 4).map(wgslNumber).join(", ")})`);
  return `mat4x4f(${columns.join(", ")})`;
}

function wgslVec3(value: Vec3): string {
  return `vec3f(${value.map(wgslNumber).join(", ")})`;
}

function wgslNumber(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function writeVec3(variable: string, offset: number): string[] {
  return [
    `  out.values[${offset}] = ${variable}.x;`,
    `  out.values[${offset + 1}] = ${variable}.y;`,
    `  out.values[${offset + 2}] = ${variable}.z;`,
  ];
}
