import { prepareShader } from "@vgpu/wgsl/prepare";
import { describe, expect, test } from "vitest";
import { evaluateShaderModule } from "../../../wgsl/tests/helpers/evaluate-shader-module.ts";
import { shaderSourceModule } from "../../../wgsl/src/loader-shared/emit.ts";
import { compute, effect, frame, init, storage, target } from "../../src/node.ts";

const PREPARED_F32 = `
struct Inner {
  direction: vec3f,
  weight: f32,
}
struct Params {
  head: f32,
  @align(32) @size(32) padded: f32,
  inner: Inner,
  basis: mat3x3f,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;

@compute @workgroup_size(1) fn cs_main() {
  output[0] = vec4f(params.head, params.padded, params.inner.direction.y, params.inner.weight);
  output[1] = vec4f(params.basis[0].x, params.basis[1].y, params.basis[2].z, params.basis[2].x);
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(params.inner.direction.x, params.padded, params.basis[1].z, params.head);
}
`;

const PREPARED_F16 = `
enable f16;
struct HalfInner {
  direction: vec3h,
  weight: f16,
}
struct HalfParams {
  @align(16) inner: HalfInner,
  @align(32) @size(32) scale: f16,
  basis: mat2x2h,
}
@group(0) @binding(0) var<uniform> params: HalfParams;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;

@compute @workgroup_size(1) fn cs_main() {
  output[0] = vec4f(f32(params.inner.direction.x), f32(params.inner.direction.z), f32(params.inner.weight), f32(params.scale));
  output[1] = vec4f(f32(params.basis[0].x), f32(params.basis[0].y), f32(params.basis[1].x), f32(params.basis[1].y));
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(f32(params.basis[0].x), f32(params.basis[1].y), f32(params.scale), f32(params.inner.weight));
}
`;

const PREPARED_LARGE = `
struct LargeParams {
  m0: mat4x4f,
  m1: array<vec4f, 4>,
  m2: vec4f,
  m3: mat4x4f,
  m4: array<vec4f, 4>,
  m5: vec4f,
  m6: mat4x4f,
  m7: array<vec4f, 4>,
}
@group(0) @binding(0) var<uniform> params0: LargeParams;
@group(0) @binding(1) var<uniform> params1: LargeParams;
@group(0) @binding(2) var<uniform> params2: LargeParams;
@group(0) @binding(3) var<uniform> params3: LargeParams;
@group(0) @binding(4) var<storage, read_write> output: array<vec4f>;

@compute @workgroup_size(1) fn cs_main() {
  output[0] = vec4f(params0.m0[0].x, params1.m1[2].y, params2.m2.z, params3.m3[3].w);
  output[1] = vec4f(params0.m4[1].x, params1.m5.y, params2.m6[2].z, params3.m7[3].w);
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(params0.m0[1].y, params1.m1[0].z, params2.m5.w, params3.m6[0].x);
}
`;

const F32_PATH = "<native-prepared-layout:f32>";
const F16_PATH = "<native-prepared-layout:f16>";
const LARGE_PATH = "<native-prepared-layout:large>";
const PREPARED_F32_ARTIFACT = prepareShader(PREPARED_F32, F32_PATH);
const PREPARED_F16_ARTIFACT = prepareShader(PREPARED_F16, F16_PATH);
const PREPARED_LARGE_ARTIFACT = prepareShader(PREPARED_LARGE, LARGE_PATH);

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("prepared shader layout packing on a real GPU", () => {
  test("compute and effect preserve nested, explicit and matrix layout bytes", async () => {
    const emitted = await loaderArtifact(PREPARED_F32, F32_PATH, false);
    const gpu = await init();
    try {
      for (const prepared of [PREPARED_F32_ARTIFACT, emitted]) {
        await expectPreparedPacking(
          gpu,
          prepared,
          {
            params: {
              head: 1,
              padded: 2,
              inner: { direction: [3, 4, 5], weight: 6 },
              basis: [7, 8, 9, 10, 11, 12, 13, 14, 15],
            },
          },
          [1, 2, 4, 6, 7, 11, 15, 13],
          [3, 2, 12, 1],
        );
      }
    } finally {
      gpu.dispose();
    }
  });

  test("shader-f16 preserves the same prepared compute/effect boundary when supported", async ({ skip }) => {
    const emitted = await loaderArtifact(PREPARED_F16, F16_PATH, false);
    let gpu: Awaited<ReturnType<typeof init>>;
    try {
      gpu = await init({ requiredFeatures: ["shader-f16"] });
    } catch (error) {
      if (error instanceof Error && (error as Error & { readonly code?: string }).code === "VGPU-FEATURE-UNSUPPORTED") {
        skip(`shader-f16 unsupported by the native adapter: ${error.message}`);
      }
      throw error;
    }

    try {
      for (const prepared of [PREPARED_F16_ARTIFACT, emitted]) {
        await expectPreparedPacking(
          gpu,
          prepared,
          {
            params: {
              inner: { direction: [1.5, 2.5, 3.5], weight: 4.5 },
              scale: 5.5,
              basis: [6.5, 7.5, 8.5, 9.5],
            },
          },
          [1.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5],
          [6.5, 9.5, 5.5, 4.5],
        );
      }
    } finally {
      gpu.dispose();
    }
  });

  test("large repeated matrix and array layouts execute from the naturally packed loader path", async () => {
    const emitted = await loaderArtifact(PREPARED_LARGE, LARGE_PATH, true);
    const value = {
      m0: sequence(1, 16),
      m1: vectors(20),
      m2: [40, 41, 42, 43],
      m3: sequence(50, 16),
      m4: vectors(70),
      m5: [90, 91, 92, 93],
      m6: sequence(100, 16),
      m7: vectors(120),
    };
    const gpu = await init();
    try {
      for (const prepared of [PREPARED_LARGE_ARTIFACT, emitted]) {
        await expectPreparedPacking(
          gpu,
          prepared,
          { params0: value, params1: value, params2: value, params3: value },
          [1, 29, 42, 65, 74, 91, 110, 135],
          [6, 22, 93, 100],
        );
      }
    } finally {
      gpu.dispose();
    }
  });
});

async function expectPreparedPacking(
  gpu: Awaited<ReturnType<typeof init>>,
  prepared: ReturnType<typeof prepareShader>,
  set: Record<string, unknown>,
  expectedCompute: readonly number[],
  expectedEffect: readonly number[],
): Promise<void> {
  const output = storage(gpu, expectedCompute.length * Float32Array.BYTES_PER_ELEMENT);
  const kernel = compute(gpu, prepared, { entry: "cs_main", set: { ...set, output } });
  await kernel.compile();
  kernel.dispatch(1);
  await gpu.settled();
  expect([...new Float32Array(await output.read())]).toEqual(expectedCompute);

  const color = target(gpu, { size: [1, 1], format: "rgba32float", label: "prepared-layout-color" });
  const shader = effect(gpu, prepared, { entry: { fragment: "fs_main" }, set });
  await shader.compile(color);
  await frame(gpu, (currentFrame) => currentFrame.pass(color, shader)).done;
  expect([...(await color.color.readFloats({ mipLevel: 0, region: "all" })).subarray(0, 4)]).toEqual(expectedEffect);
}

async function loaderArtifact(source: string, path: string, requirePacked: boolean): Promise<ReturnType<typeof prepareShader>> {
  const code = shaderSourceModule(source, path, []);
  const expected = prepareShader({ wgsl: source, functionExports: [] }, path);
  if (requirePacked) {
    expect(Buffer.byteLength(JSON.stringify(expected.reflection))).toBeGreaterThanOrEqual(32 * 1024);
    expect(code).toContain("decodePackedMetadata");
  }
  const artifact = await evaluateShaderModule(code);
  expect(artifact).toStrictEqual(prepareShader({ wgsl: artifact.wgsl, functionExports: artifact.functionExports }, path));
  return artifact;
}

function sequence(start: number, length: number): number[] {
  return Array.from({ length }, (_, index) => start + index);
}

function vectors(start: number): number[][] {
  return Array.from({ length: 4 }, (_, vector) => sequence(start + vector * 4, 4));
}
